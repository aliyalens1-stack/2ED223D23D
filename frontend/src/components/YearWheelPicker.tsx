// YearWheelPicker — iOS-style barrel/wheel picker for selecting a year. Built on
// top of FlatList with snapToInterval to avoid taking on a native picker
// dependency. Works the same on iOS / Android / web.
//
// UX:
//   - Renders a fixed-height wheel; the row aligned to the centre is the
//     "selected" value. Tap any row to centre it.
//   - Years are rendered descending (current → minYear). The currently selected
//     year is highlighted via a centre overlay band.
//   - Used inside a Modal in the parent (so the rest of the form is dimmed
//     while the user spins the wheel).
//
// Contract:
//   value      — currently selected year (number) | null when "any"
//   onChange   — fires with new year on every snap
//   minYear    — defaults to 1990
//   maxYear    — defaults to current year + 1 (for fresh listings)
import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Platform,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';

const ROW_HEIGHT = 44;
const VISIBLE_ROWS = 5; // odd number → centre row is the "selected" one

export type YearWheelPickerProps = {
  value: number | null;
  onChange: (year: number) => void;
  minYear?: number;
  maxYear?: number;
  colors: any;
};

export default function YearWheelPicker({
  value,
  onChange,
  minYear = 1990,
  maxYear = new Date().getFullYear() + 1,
  colors,
}: YearWheelPickerProps) {
  // Years descending: maxYear at the top
  const years = useMemo(() => {
    const arr: number[] = [];
    for (let y = maxYear; y >= minYear; y--) arr.push(y);
    return arr;
  }, [minYear, maxYear]);

  const listRef = useRef<FlatList<number>>(null);

  // Initial scroll-to-selected. When value changes externally, sync the wheel.
  useEffect(() => {
    if (value == null) return;
    const idx = years.indexOf(value);
    if (idx < 0) return;
    // setTimeout to ensure FlatList layout is ready
    const t = setTimeout(() => {
      listRef.current?.scrollToOffset({ offset: idx * ROW_HEIGHT, animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [value, years]);

  // Snap handler. Compute the index nearest to current scroll offset and emit.
  const handleMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = e.nativeEvent.contentOffset.y;
    const idx = Math.round(offset / ROW_HEIGHT);
    const clamped = Math.max(0, Math.min(years.length - 1, idx));
    const year = years[clamped];
    if (year !== value) onChange(year);
  };

  const renderItem = ({ item, index }: { item: number; index: number }) => {
    const isSelected = item === value;
    return (
      <TouchableOpacity
        testID={`year-row-${item}`}
        activeOpacity={0.6}
        onPress={() => {
          listRef.current?.scrollToOffset({ offset: index * ROW_HEIGHT, animated: true });
          onChange(item);
        }}
        style={styles.row}
      >
        <Text
          style={[
            styles.rowTxt,
            { color: isSelected ? colors.text : colors.textSecondary, fontWeight: isSelected ? '800' : '500', fontSize: isSelected ? 22 : 18 },
          ]}
        >
          {item}
        </Text>
      </TouchableOpacity>
    );
  };

  const wheelHeight = ROW_HEIGHT * VISIBLE_ROWS;
  const padTop = (VISIBLE_ROWS - 1) / 2 * ROW_HEIGHT;

  return (
    <View style={[styles.wrapper, { height: wheelHeight }]}>
      {/* Centre highlight band — sits behind the FlatList */}
      <View
        pointerEvents="none"
        style={[
          styles.centerBand,
          {
            top: padTop,
            backgroundColor: 'rgba(245,184,0,0.10)',
            borderColor: colors.primary,
          },
        ]}
      />

      <FlatList
        ref={listRef}
        data={years}
        keyExtractor={(y) => String(y)}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        snapToInterval={ROW_HEIGHT}
        decelerationRate="fast"
        onMomentumScrollEnd={handleMomentumEnd}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        contentContainerStyle={{ paddingTop: padTop, paddingBottom: padTop }}
        // On Web, momentum events sometimes don't fire — also handle scroll end.
        onScrollEndDrag={Platform.OS === 'web' ? handleMomentumEnd : undefined}
      />

      {/* Top + bottom fade gradients (CSS-only — soft overlays) */}
      <View pointerEvents="none" style={[styles.fadeTop, { backgroundColor: colors.background }]} />
      <View pointerEvents="none" style={[styles.fadeBottom, { backgroundColor: colors.background }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
    position: 'relative',
  },
  row: {
    height: ROW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTxt: {
    letterSpacing: -0.3,
  },
  centerBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderRadius: 8,
  },
  fadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    opacity: 0.55,
  },
  fadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    opacity: 0.55,
  },
});
