import { existsSync } from 'node:fs';
import path from 'node:path';
export function assertServerStopped(config){
  if(existsSync(path.join(config.dataDir,'server.lock')))throw new Error('Stop the service before Android maintenance. If it crashed, confirm no instance is running before removing data/server.lock.');
}
