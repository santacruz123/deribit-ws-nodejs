import { Adapter, log, error, nextTick } from './adapter'

import crypto from 'crypto'

let privateMethods = [
  'account',
  'buy',
  'cancel',
  'cancelall',
  'edit',
  'getopenorders',
  'newannouncements',
  'orderhistory',
  'orderstate',
  'positions',
  'sell',
  'subscribe',
  'tradehistory',
]

function serialize(m) {
  return Object.keys(m)
    .sort()
    .map(k => (Array.isArray(m[k]) ? `${k}=${m[k].join('')}` : `${k}=${m[k]}`))
    .join('&')
}

function sig(action, obj = {}, key, sec) {
  if (!key || !sec) {
    let err = new Error('Deribit key/secret missing')
    err.name = 'deribit_auth'
    throw err
  }

  let time = new Date().getTime()

  let m = Object.assign(
    {
      _: time,
      _ackey: key,
      _acsec: sec,
      _action: action,
    },
    obj,
  )

  let str = serialize(m)

  let hash = crypto.createHash('sha256')
  hash.update(str)

  let sig = `${key}.${time}.${hash.digest('base64')}`

  return sig
}

let wsEvents = {
  index: {
    hook: 'order_book',
    filter: () => true,
  }, // order book change
  order_book_event: {
    hook: 'order_book',
    filter: (msg, filter) => {
      let arrFilter = Array.isArray(filter) ? filter : [filter]
      return arrFilter.includes(msg.instrument)
    },
  }, // order book change
  trade_event: {
    hook: 'trade',
    filter: (msg, filter) => {
      let arrFilter = Array.isArray(filter) ? filter : [filter]
      return arrFilter.includes(msg.instrument)
    },
  }, // trade notification
  user_orders_event: {
    hook: 'user_order',
    filter: (msg, filter) => {
      let arrFilter = Array.isArray(filter) ? filter : [filter]
      return arrFilter.includes(msg.instrument)
    },
  }, // change of user orders (openning, cancelling, filling)
  my_trade_event: {
    hook: 'my_trade',
    filter: (msg, filter) => {
      let arrFilter = Array.isArray(filter) ? filter : [filter]
      return arrFilter.includes(msg.instrument)
    },
  }, // my trade notification
}

export default class WS {
  constructor(opt) {
    this.opt = opt

    let testnet = typeof opt.testnet !== 'undefined' ? opt.testnet : false

    this.hooks = {
      order_book: [], // order book change
      trade: [], // trade notification
      user_order: [], // change of user orders (openning, cancelling, filling)
      my_trade: [], // my trade notification
    }

    let url = testnet
      ? 'wss://test.deribit.com/ws/api/v1/'
      : 'wss://www.deribit.com/ws/api/v1/'

    log('Connecting to ' + url)

    this.ws = new Adapter(url)

    /* eslint-disable-next-line no-undef */
    this.connected = new Promise(resolve => {
      this.ws.onOpen(() => {
        resolve()
        log('Connected')
      })
    })

    this.ws.onMessage(msg => this._onMessage(msg))
    this.ws.onError(error)

    this.n = 1
    this.promises = {}

    setInterval(async () => {
      this._ping()
    }, 30000)
  }

  _onMessage(msg) {
    let res
    try {
      res = JSON.parse(msg)
    } catch (err) {
      error('Error parsing', msg)
      return
    }

    if (typeof res.success === 'boolean' && !res.success) {
      if (this.opt.error) {
        nextTick(() => this.opt.error(res.message))
      }

      return error('onMessage: ', res.message)
    }

    log('Got', res)

    if (res.notifications) {
      if (Array.isArray(res.notifications)) {
        nextTick(() => this._notifications(res.notifications))
        return
      } else {
        nextTick(() => this._notifications([res.notifications]))
      }
    }

    if (!res.id) {
      return
    }

    let { resolve, action } = this.promises[res.id]

    if (this.opt.message) {
      nextTick(() => this.opt.message(res.result))
    }

    if (this.opt[action]) {
      nextTick(() => this.opt[action](res.result))
    }

    nextTick(() => resolve(res.result))

    delete this.promises[res.id]
  }

  _send(json) {
    log('Sending', json)
    this.ws.send(JSON.stringify(json))
  }

  close() {
    this.ws.close()
  }

  action(action, args = {}) {
    action = action.toLowerCase()

    let privacy = privateMethods.includes(action) ? 'private' : 'public'

    let id = this.n++

    return new Promise(resolve => {
      this.promises[id] = {
        resolve,
        action,
      }

      let msg = {
        id,
        action: `/api/v1/${privacy}/${action}`,
        arguments: args,
      }

      msg.arguments.continue = true

      if (privateMethods.includes(action)) {
        msg.sig = sig(msg.action, msg.arguments, this.opt.key, this.opt.secret)
      }

      this._send(msg)
    })
  }

  subscribe(event = 'order_book', instrument = 'all') {
    this.action('subscribe', {
      instrument: Array.isArray(instrument) ? instrument : [instrument],
      event: Array.isArray(event) ? event : [event],
    })
  }

  disconnect() {
    let msg = {
      id: 'disconnect',
      action: '/api/v1/private/unsubscribe',
    }
    msg.sig = sig(msg.action, msg.arguments, this.key, this.secret)
    this._send(msg)
  }

  _ping() {
    this._send({ action: '/api/v1/public/ping' })
  }

  hook(...args) {
    let cb = args.pop()
    let event = args.shift()

    let filter = args[0] ? args[0] : null

    let one = { cb }

    if (filter) {
      one.subscribe = one.filter = Array.isArray(filter) ? filter : [filter]
      one.filter = one.filter.filter(
        o => !['all', 'futures', 'options', 'index'].includes(o),
      )
    }

    this.hooks[event].push(one)
    this.subscribe(event, one.subscribe ? one.subscribe : 'all')
  }

  _notifications(ntfs) {
    ntfs.forEach(ntf => {
      let { hook, filter } = wsEvents[ntf.message]

      let hooks = this.hooks[hook] || []
      if (hooks.length === 0) return

      let msgs = Array.isArray(ntf.result) ? ntf.result : [ntf.result]

      hooks.forEach(oneHook => {
        msgs.forEach(msg => {
          if (!oneHook.filter || oneHook.filter.length === 0) {
            nextTick(() => oneHook.cb(msg))
            return
          }

          if (filter(msg, oneHook.filter)) {
            nextTick(() => oneHook.cb(msg))
          }
        })
      })
    })
  }
}
