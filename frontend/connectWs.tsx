import config from '../config';
import ReconnectingWebSocket, { CloseEvent } from 'reconnecting-websocket';

export function connectWs(type: string, opts: { onMessage?(event: MessageEvent), onOpen?(), onClose?(event: CloseEvent) }): Promise<ReconnectingWebSocket> {
  let pingTimer;
  let opened;
  return new Promise(resolve => {
    const socket = new ReconnectingWebSocket(config.wsServer);
    
    // Connection opened
    socket.addEventListener('open', () => {
      socket.send(type);
      console.log('opened');
      opts.onOpen?.();

      if (!opened) {
        resolve(socket);
      }
    });
  
    clearInterval(pingTimer);
    let ponged;
    socket.addEventListener('message', event => {
      if (event.data == 'pong') {
        ponged = true;
        return;
      }

      opts.onMessage?.(event);
    });
  
    socket.addEventListener('close', (event) => {
      console.log('closed', event.code);
      opts.onClose?.(event);
    });
  
    socket.addEventListener('error', (event) => {
      console.log('error', event);
    });
  });

}
