// Polyfills MUST load before anything imports viem/the SDK.
import './src/polyfills';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
