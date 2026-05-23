// AutoSearch Experts brand wordmark.
// Renders the existing "A | SEARCH" PNG lock-up with a tight "EXPERTS"
// subtitle placed below the SEARCH wordmark so the composition remains
// compact and aligned with the wordmark's right edge.
//
// Aspect ratio of the PNG: 4.17:1 (1192×286).
import React from 'react';
import { View, Image, Text, StyleProp, ViewStyle, StyleSheet } from 'react-native';
import { useThemeContext } from '../context/ThemeContext';

type Props = {
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Hide the "EXPERTS" subtitle (rare — keep the bare wordmark). */
  hideSubtitle?: boolean;
};

const ASPECT = 1192 / 286; // ≈ 4.17
const DARK = require('../../assets/brand/logo-dark.png');
const LIGHT = require('../../assets/brand/logo-light.png');

export default function Brand({ height = 28, style, testID, hideSubtitle = false }: Props) {
  const { isDark } = useThemeContext();
  const source = isDark ? DARK : LIGHT;
  const width = height * ASPECT;

  // Subtitle: ~26% of mark height, tracked-out caps. Right-padded so the
  // "EXPERTS" text sits visually under "SEARCH" (the "A |" block occupies
  // roughly the first ~22% of the wordmark width).
  const subFontSize = Math.max(7, Math.round(height * 0.26));
  const subLetterSpacing = Math.max(1, Math.round(subFontSize * 0.32));
  const subColor = isDark ? '#FFFFFF' : '#0A0A0A';
  // Pull subtitle slightly closer to the wordmark for a tighter lock-up.
  const subMarginTop = Math.max(-2, -Math.round(height * 0.08));

  return (
    <View style={[styles.container, { width }, style]} testID={testID || 'brand-logo'}>
      <Image
        source={source}
        style={{ height, width }}
        resizeMode="contain"
      />
      {!hideSubtitle && (
        <Text
          style={[
            styles.subtitle,
            {
              fontSize: subFontSize,
              letterSpacing: subLetterSpacing,
              color: subColor,
              marginTop: subMarginTop,
            },
          ]}
          numberOfLines={1}
          testID="brand-subtitle"
        >
          EXPERTS
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-end',
  },
  subtitle: {
    fontWeight: '700',
    textAlign: 'right',
    // Leaves the subtitle aligned under "SEARCH" (right side of the wordmark).
    opacity: 0.9,
  },
});
