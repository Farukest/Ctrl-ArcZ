// React Native polyfills that viem needs. MUST be imported before any SDK/viem
// code runs (see index.ts), or crypto/URL calls throw at runtime.
//
// - react-native-get-random-values: provides crypto.getRandomValues, used by
//   viem/@noble when generating keys, salts and nonces.
// - react-native-url-polyfill: a WHATWG URL implementation; viem's http transport
//   constructs URL objects, and Hermes ships only a partial URL.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
