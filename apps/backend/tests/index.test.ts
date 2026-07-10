import { describe, expect, test } from 'vitest';
import { isPrivateNetworkFrontendOrigin } from '../src/index.js';

describe('private-network frontend origins', () => {
  test('allows the local Vite app from a private LAN address', () => {
    expect(isPrivateNetworkFrontendOrigin('http://192.168.1.126:5173')).toBe(true);
    expect(isPrivateNetworkFrontendOrigin('http://10.0.0.4:5173')).toBe(true);
    expect(isPrivateNetworkFrontendOrigin('http://172.20.0.3:5173')).toBe(true);
  });

  test('rejects public hosts, unexpected ports, and invalid origins', () => {
    expect(isPrivateNetworkFrontendOrigin('http://8.8.8.8:5173')).toBe(false);
    expect(isPrivateNetworkFrontendOrigin('http://192.168.1.126:3000')).toBe(false);
    expect(isPrivateNetworkFrontendOrigin('not-an-origin')).toBe(false);
  });
});
