#!/usr/bin/env node

import { authorizeSpotify } from './config.js';

console.log('Starting Spotify authentication flow...');
authorizeSpotify()
  .then(() => {
    console.log('Authentication completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Authentication failed:', error);
    process.exit(1);
  });
