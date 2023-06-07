import Hapi from '@hapi/hapi';
import WebSocket from 'ws';
import serialize from 'serialize-javascript';
import _ from 'lodash';
import { ObservableDB } from './src/observableMongo/ObservableDB';
import { createObservableDB } from './src/observableMongo/createObservableDB';
import { config } from './src/config';
import { unserialize } from './src/unserialize';
import { wrapDb } from './src/wrapDb';
import { createMongoDriver } from './src/observableMongo/observableMongo';
import { XObject } from './XObject';


process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";


enum ConnectionType {
  functions = 'functions',
}

interface FuncSub {
  cancel();
}

export type F = <T>(f: () => T) => T;

export interface Params {
  userId;
  db
  w?: F;
  config?;
}


const createGetFunc = (db: ObservableDB, functions) => {
  const cache: {
    [key: string]: any
  } = {};

  return function getFunc(funcName, args, session) {
    const key = JSON.stringify([ funcName, args, session ]);

    if (cache[key]) return cache[key];
    const subscribers = [];

    let dataIds = null;

    let timerId;
    function observer() {
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        console.log('[func] func updated', funcName, args, session, subscribers.length);
        for (const sub of subscribers) {
          sub();
        }
      }, 100);
    }

    function close() {
      console.log('[func] func closed', funcName, args, session);
      if (dataIds) {
        for (const id of dataIds) {
          db.stopObserving(id, observer);
        }
      }
      delete cache[key];
    }

    return cache[key] = {
      async get() {
        if (dataIds) {
          for (const id of dataIds) {
            db.stopObserving(id, observer);
          }
        }
        const observableDb = db.createReadObserver();
        const f = functions({
          userId: session.user,
          db: wrapDb(observableDb),
          w: f => {
            return XObject.captureAccesses(() => {
              return f();
            }, (obj, prop) => {
              // console.log('[func]', funcName, args, '===observe', prop);
              // TODO: stop observing 
              XObject.observe(obj, prop, () => {
                // console.log('===changed', x(obj), prop);
                observer();
              });
            });
          }
        });
        let response;
        try {
          response = await f[funcName](session, ...(args || []));
        }
        catch (e) {
          console.log(e);
          console.log('[func] failed', funcName, args);
          // Sentry.captureException(e);
        }

        dataIds = observableDb.reads();

        // console.log('[func]', funcName, args, dataIds);

        for (const id of dataIds) {
          db.observe(id, observer);
        }

        return response;
      },
      subscribe(observer): FuncSub {
        subscribers.push(observer);

        return {
          cancel() {
            const index = subscribers.indexOf(observer);
            if (index != -1) {
              subscribers.splice(index, 1);
            }

            if (subscribers.length == 0) {
              close();
            }
          }
        }
      },
      id: key,
    }
  }
}

export const init = async ({ mongoDb, functions }) => {
  console.log('initing db...');
  const db = await createObservableDB(createMongoDriver(mongoDb));

  const wrappedDb = wrapDb(db);

  const getFunc = createGetFunc(db, functions);

  const _db: ObservableDB = db as any;
  let callId = 1;
  async function call(name, user, args, client) {
    try {
      const func = functions({ userId: user, db: wrapDb(_db.taggedDb({ tag: (callId ++) + '-' + name + '-' + user, client })), w: f => f(), config })[name];
      if (!func) {
        throw new Error(`${name} does not exist`);
      }
      const r = await func({ user }, ...(args || []));

      wrappedDb.callLogEntries.insertOne({ user, timestamp: new Date(), content: {
        name,
        args,
        result: serialize(r),
      } })

      return r;
    }
    catch (e) {
      console.log(e);
      wrappedDb.callLogEntries.insertOne({ user, timestamp: new Date(), content: {
        name,
        args,
        // error: serializeError(e),
      } })

      // Sentry.captureException(e);

      throw e;
    }
  }

  async function startServer() {
    console.log('starting server...');
    const wss = new WebSocket.Server({ port: config.wsPort });

    wss.on('connection', ws => {
      let connectionType: ConnectionType;
      const funcSubs: FuncSub[] = [];
      const funcSubsMap = {};
      const closeCbs = [];
      ws.on('message', async data => {
        if (!connectionType) {
          connectionType = data as any;
          return;
        }

        if (connectionType == ConnectionType.functions) {
          const [ id, action, ...rest ] = unserialize(data.toString());
          if (action == 'subscribe') {
            const [ name, { user, args } ] = rest;
            const f = getFunc(name, args, { user: user });
            funcSubs.push(funcSubsMap[id] = f.subscribe(async () => {
              ws.send(serialize([ 'data', f.id, await f.get() ]));
            }));
            ws.send(serialize([ 'subscribed', id, f.id, await f.get() ]));    
          }
          else if (action == 'unsubscribe') {
            funcSubsMap[id].cancel();
            funcSubs.splice(funcSubs.indexOf(funcSubsMap[id]), 1);
            delete funcSubsMap[id];
          }
        }

      });

      ws.on('close', () => {
        for (const cb of closeCbs) {
          cb();
        }
        if (connectionType == ConnectionType.functions) {
          for (const sub of funcSubs) {
            sub.cancel();
          }
        }
      })
    });

    const server = Hapi.server({
      routes: {
        payload: {
          multipart: true
        }
      },
      port: config.httpPort,
      host: '0.0.0.0',
    });
  
    await server.register(require('@hapi/inert'));
  
  
    await server.register({
      plugin: require('hapi-dev-errors'),
      options: {
        showErrors: true
      }
    });
  
    await server.register({
      plugin: require('hapi-cors'),
    });
  
    await server.start();
    console.log('Server running on %s', server.info.uri);




    server.route({
      method: 'POST',
      path: '/call',
      config: {
        payload: {
          parse: false,
        },
      },
      async handler(request) {
        const payload = eval(`(${request.payload.toString('utf8')})`);
        const response = await call(request.query.name, payload.user, payload.args, request.query.client)
        return serialize({
          status: 'success',
          response
        });
      }
    });
  }

  return { startServer, wrappedDb };
};



const example = async () => {
  function functions(params: Params) {
    const { db } = params;
    const funcs = {
      async 'notes.list'({ user }) {
        return await db.notes.find();
      },
  
      async 'notes.create'({ user }, content) {
        await db.notes.insertOne({
          content
        });
      }
    }
    return funcs;
  }
  const { startServer } = await init({
    mongoDb: null, // pass a mongodb instance
    functions,
  })
  startServer();
}