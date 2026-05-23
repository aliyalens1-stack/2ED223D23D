// This file handles the conditional import of react-native-maps
// to avoid "native-only module" errors on web

import { Platform } from 'react-native';

// Export empty components for web
export const MapView = Platform.OS === 'web' ? null : require('react-native-maps').default;
export const Marker = Platform.OS === 'web' ? null : require('react-native-maps').Marker;
export const Circle = Platform.OS === 'web' ? null : require('react-native-maps').Circle;

export const isMapAvailable = Platform.OS !== 'web';
