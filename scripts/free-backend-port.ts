import {
  getBackendServerConfig,
  loadServerConfig,
} from '../apps/backend/src/config/serverConfig.ts';
import { freeListeningPort } from './free-listening-port.ts';

const { backendPort } = getBackendServerConfig(loadServerConfig());

freeListeningPort(backendPort);
