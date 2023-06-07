import { DeepMutation, _X, XObject, X, XInit, reactDisplay, x } from './XObject';
import { StillLoading } from './@component';
import _, { get } from 'lodash';
import axios from 'axios';
import config from './config';
import serialize from 'serialize-javascript';
import { connectWs } from './connectWs';

const CLIENT_ID = XObject.id();

export interface APIArray<T, Y=any> extends Array<T> {
  add(Y): any;
}


interface Connection {
  send: any;
  onMessage: (observer) => { stop };
  onReopen;
}

let connection: Connection;


export const socketState = XInit(class { connected = false; error = false; });

interface ConnectionObserver {
  stop
}

export async function initApiSystem() {
  const observers = [];
  const messageQueue = [];

  const reopenCbs = [];

  connection = {
    send(...args) {
      console.log(args);
      if (socketState.connected) {
        socket.send(JSON.stringify(args));
      }
      else {
        messageQueue.push(args);
      }
    },
    onMessage(observer): ConnectionObserver {
      observers.push(observer);
      return { stop() {
        const index = observers.indexOf(observer);
        if (index !== -1) {
          observers.splice(index, 1);
        }
      } };
    },
    onReopen(cb) {
      reopenCbs.push(cb);
    },
  }

  let opened;

  const socket = await connectWs('functions', {
    onMessage(event) {
      const data = eval(`(${event.data})`);
      console.log('message', data);
      for (const o of observers) {
        o(...data);
      }
    },
    onClose(event) {
      socketState.connected = false;
      console.log('closed');
    },
    onOpen() {
      socketState.connected = true;

      if (opened) {
        for (const cb of reopenCbs) cb();
      }
      else {
        opened = true;
      }
    }
  });

  socketState.connected = true;
  for (const message of messageQueue) {
    socket.send(JSON.stringify(message));
  }
}


export function comparePaths(a, b) {
  return _.isEqual(resolvePath(a), resolvePath(b));
}

function makePathGen(comps=[]) {
  return new Proxy({}, {
    get({}, prop) {
      if (prop == '$') return comps;
      else if (prop == '.') return comps.join('.');
      else if (prop == '$last') return comps[comps.length - 1];
      else if (prop == '__path') return true;
      return makePathGen(comps.concat(prop));
    }
  })
}


function getPath(path: any): string[] {
  return path.$;
}

export function pather<T>(obj?: T): T {
  return makePathGen();
}

function resolvePath(path) {
  if (path.__path) path = path.$;
  return path;
}


interface IAsyncResolve<T=any> {
  readonly $ready: boolean;
  readonly $onReady: Promise<boolean>;
  readonly $value: T;
}


type GetterOpts<T=any> = {
  cache: boolean;
  tag?: any;
  get: (getter: Getter) => Promise<T>,
  // onAdd?: (instance: T) => void,
  onMutation?: (mutation: DeepMutation, obj: T) => void,
  onBatchMutations?: (mutations: DeepMutation[], obj: T) => void,
  onDelete?: () => void;

  id?: string;
};

class Getter {
  private _obj;
  private _raw;
  private _ready: boolean;
  private _getting: boolean;

  private _promise: Promise<boolean>;
  private _resolve;

  private _batchedMutations: DeepMutation[];

  private _batchingTimerId;

  public get id(): string {
    return this.opts.id;
  }

  tick = new Date();

  constructor(public opts: GetterOpts) {
    this._obj = _X();
    this._promise = new Promise(resolve => this._resolve = resolve);
  
    this._obj[XObject._transientSymbol] = {
      '': {
        get: p => {
          if (!this._ready) {
            XObject.onAccess(this._obj, null);
            throw new StillLoading();
          }
        }
      },
      $ready: {
        trackAccess: true,
        get: () => this._ready
      },
      $onReady: {
        get: () => this._promise
      },
      [reactDisplay]: {
        trackAccess: true,
        get: () => this._raw
      },
      $value: {
        trackAccess: true,
        get: () => this._raw
      },
    }

    XObject.observeObservers(this._obj, pather<IAsyncResolve>().$ready['.'], observers => {
      if (!observers) {
        for (const obs of this._notObservedFuncs) {
          obs(() => {
            setTimeout(() => {
              this._notObservedFuncs.splice(this._notObservedFuncs.indexOf(obs), 1);
            }, 0);
          });
        }
      }
    });

    // const timerId = setInterval(() => {
    //   console.log(XObject.ob)

    // }, 4000);
  }

  async update(force=false) {
    if (force || !this._getting && !this._ready) {
      this._getting = true;
      this.tick = new Date();
      const obj = this._raw = await this.opts.get(this);
      // console.log('raw', x(this._raw));
      X(obj, undefined, undefined, this._obj, obj => {
        if (XObject.isArray(obj)) {
          obj[XObject._transientSymbol] = {
            add: {
              get: () => {
                return (...args) => {
                  obj[XObject._fireMutationSymbol]('custom', { customType: 'add', args });
                }
              }
            }
          }
        }
      });
      this._ready = true;

      XObject.observe(this._obj, mutation => {

        const handleMutation = mutation => {
          if (this.opts.onBatchMutations) {
            if (!this._batchedMutations) this._batchedMutations = [ mutation ];
            else this._batchedMutations.push(mutation);
  
            clearTimeout(this._batchingTimerId);
            this._batchingTimerId = setTimeout(() => {
              this.opts.onBatchMutations(this._batchedMutations, this._obj);
              delete this._batchedMutations;
              delete this._batchingTimerId;
            }, 10);  
          }
          
          this.opts.onMutation?.(mutation, this._obj);  
        }

        if (mutation.type == 'set') {
          if (mutation.path[0] == '$ready') {
            return;
          }
        }
        else if (mutation.type == 'custom') {
          handleMutation({
            type: 'add',
            path: mutation.path,
            value: mutation.customMutation.args,
          })
          return;
        }

        handleMutation(mutation);

      });

      XObject.changed(this._obj, pather<IAsyncResolve>().$ready);
      this._getting = false;  

      this._resolve(true);
    }
  }

  get obj() {
    // if (this._ready) this._ready = false;
    return this._obj;
  }

  get promise() {
    return this._promise;
  }

  timerId

  _notObservedFuncs = [];
  
  onNotObserved(func) {
    this._notObservedFuncs.push(func);
  }

  invalidate() {
    clearTimeout(this.timerId);

    this.timerId = setTimeout(() => {
      if (this._ready) {
        this.update(true);
      }  
    }, 100)
  }
}

interface State {
  getGetter(name, args, opts: FunctionOpts): Getter;
}

function callFunction(state: State, name, args, opts: FunctionOpts) {
  const getter = state.getGetter(name, args, opts);
  getter.update();

  // eslint-disable-next-line
  getter.obj.$ready;
  return getter.obj;
}

export function createFunctionNoArgs<T=any>(name, opts: FunctionOpts = {}): () => T & IAsyncResolve<T> {
  return {
    func: (state) => callFunction(state, name, [], opts),
    args: false
  } as any;
}


interface FunctionOpts {
  transform?(data: any): any;
  invalidate?: (thisArgs: any[], mutation: any, name: string, args: any[]) => boolean;
  live?: boolean;
}


export function createFunction<T extends (...args) => any=any>(name, opts: FunctionOpts = {}): (...a: Parameters<T>) => (ReturnType<T> & IAsyncResolve<ReturnType<T>>) {
  return {
    func: (state, ...args) => callFunction(state, name, args, opts),
    args: true
  } as any;
}


interface ProcedureOpts {
  invalidate?: (procArgs: any[], name: string, args: any[]) => boolean;
}

export function createProcedure<T extends (...args:any) => any=(() => void)>(name: string, opts: ProcedureOpts = {}): (...a: Parameters<T>) => Promise<ReturnType<T>> {
  return {
    proc: {
      name, opts
    } 
  } as any;
}

interface WithApi<T> {
  withApi(api: ModelApi): T & WithApi<T>
}

interface ModelApi {
  disableCache?: boolean;
  call: (name: string, args: any[], opts?: FunctionOpts, getter?: Getter) => Promise<any>;
  mutate?: (name, args, mutation: any[]) => Promise<void>;
}

export function createModel<T>(def: T, api: ModelApi=remoteApi()): T & WithApi<T> {
  const cache: { [key: string]: Getter } = {};

  const state: State = {
    getGetter(name, args, opts) {
      const key = JSON.stringify([ name, args ]);
      if (cache[key]) return cache[key];

      const g = cache[key] = new Getter({
        cache: !api.disableCache,
        id: key,
        tag: [ name, args ],
        async get(getter) {
          let data = await api.call(name, args, opts, getter);
          if (opts.transform) {
            data = opts.transform(data);
          }
          return data;
        },

        // onMutation(mutation, obj) {
        //   console.log('onMutation', mutation);
        //   const m = {
        //     type: mutation.type,
        //     path: mutation.path,
        //     value: mutation.value,
        //   }
        //   // console.log(mutation, obj);
        //   api.mutate?.(name, args, [ m ]);
        // },

        async onBatchMutations(mutations, obj) {
          console.log('onBatchMutations', mutations);

          await api.mutate?.(name, args, mutations.map(mutation => ({
            type: mutation.type,
            path: mutation.path,
            value: mutation.value
          })));

          if (opts.invalidate) {
            for (const mutation of mutations) {
              for (const getter of Object.values(cache)) {
                if (opts.invalidate(args, mutation, getter.opts.tag[0], getter.opts.tag[1])) {
                  getter.invalidate();
                }
              }
            }
          }
        }
      });

      g.onNotObserved(clear => {
        delete cache[key];
        clear();
      });

      return g;
    }
  }

  function c(o): any {
    return new Proxy({}, {
      get({}, prop) {
        if (prop == 'withApi') {
          return (api) => {
            return createModel(def, api);
          }
        }
        if ('func' in o[prop]) {
          return (...args) => o[prop].func(state, ...args);
        }
        else if ('proc' in o[prop]) {
          const proc: { name, opts: ProcedureOpts } = o[prop].proc;
          return async (...args) => {
            const r = await api.call(proc.name, args);

            if (proc.opts.invalidate) {
              for (const getter of Object.values(cache)) {
                if (proc.opts.invalidate(args, getter.opts.tag[0], getter.opts.tag[1])) {
                  getter.invalidate();
                }
              }
            }
            return r;
          }
        }
        else {
          return c(o[prop]);
        }
      }
    })
  }
  return c(def);
}

interface LiveFuncObserver {
  stop();
}

const liveFunc = (() => {
  connection.onReopen(() => {
    console.log()
    for (const key in cache) {
      cache[key].reset();
      cache[key].get();
    }
  });

  const cache: { [key: string]: LiveFunc } = {};
  
  let nextMessageId = 1;

  interface LiveFunc {
    observe(observer: (data: any) => void): LiveFuncObserver;
    get();
    reset();
  }
  
  return Object.assign((name: string, args: any): LiveFunc => {
    const key = JSON.stringify([ name, args ]);

    if (cache[key]) return cache[key];

    const observers = [];

    let data;

    let getting = false;

    const resolvers = [];

    let id;

    let connectionObserver: ConnectionObserver;

    function destruct() {
      console.log('destruct', key);
      connection.send(id, 'unsubscribe');
      connectionObserver?.stop?.();
      connectionObserver = undefined;
      delete cache[key];
    }
    
    
    return cache[key] = {
      observe(observer) {
        observers.push(observer);

        return {
          stop() {
            const index = observers.indexOf(observer);
            if (index != -1) {
              observers.splice(index, 1);

              if (!observers.length) {
                destruct();
              }
            }
          }
        }
      },

      reset() {
        getting = false;
        data = undefined;
      },
      get() {
        if (getting) {
          console.log('already getting', key)
          return new Promise(resolve => {
            resolvers.push(resolve);
          });
        }

        if (data === undefined) {
          getting = true;
          id = nextMessageId++;
          let funcId;
          connection.send(id, 'subscribe', name, args);

          connectionObserver = connection.onMessage((message, ...args) => {
            getting = false;
            if (message == 'subscribed' && args[0] == id) {
              console.log('hello', id, message, args);
              funcId = args[1];
              data = args[2];

              for (const r of resolvers) {
                r(data);
              }
            }
            else if (message == 'data' && args[0] == funcId) {
              data = args[1];
              for (const o of observers) {
                o(data);
              }
            }
          });

          return new Promise(resolve => {
            resolvers.push(resolve);
          });
        }
        else {
          return Promise.resolve(data);
        }
      }
    }

  }, {
    reload() {

    }
  })
})();

function remoteApi() {
  const observers: { [key: string]: LiveFuncObserver } = {};
  const u = null;

  return {
    call: async (name, args, opts, getter: Getter) => {
      args = x(args);
      if (opts) {
        const func = liveFunc(name, { args, user: u });
  
        if (!observers[getter.id]) {
          observers[getter.id] = func.observe(() => {
            getter.invalidate();
          });

          getter.onNotObserved(clear => {
            console.log('not observed', name, args);
            observers[getter.id].stop();
            delete observers[getter.id];

            clear();
          });

        }

        const v = await func.get();
        // console.log(name, args, v);
        return v;
      }
      else {
        try {
          const r = await axios.post(`${config.apiServer}call?name=${name}&client=${CLIENT_ID}`, serialize({ args, user: u }), {
            transformResponse(data) {
              return eval(`(${data})`).response;
            }
          });
          return r.data;    
        }
        catch (e) {
          socketState.error = true;
          console.log(e);
        }
      }
    },
    mutate: async (name, args, mutations) => {
      await axios.post(`${config.apiServer}mutate?name=${name}`, serialize({ user: u, args, mutations }));
    },

  }
}

function example() {
  const model = createModel({
    notes: {
      list: createFunction<(query?) => {_id, content}[]>('notes.list'),
      create: createProcedure<(content) => string>('notes.create'),
    },
  });
}