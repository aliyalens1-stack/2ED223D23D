// YearRangeModal — modal that hosts two YearWheelPicker columns side-by-side
// for picking "year from" / "year to" in one go. Replaces the two
// numeric TextInputs in /auto-request/create.tsx.
//
// Behaviour:
//   - "any" toggle is supported via the "Сбросить" button (sets value to null).
//   - On confirm, fires onConfirm(yearFrom, yearTo). Caller is responsible for
//     ordering validation.
import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import YearWheelPicker from './YearWheelPicker';

export type YearRangeModalProps = {
  visible: boolean;
  initialFrom: number | null;
  initialTo: number | null;
  onConfirm: (from: number | null, to: number | null) => void;
  onClose: () => void;
  colors: any;
  minYear?: number;
  maxYear?: number;
};

export default function YearRangeModal({
  visible, initialFrom, initialTo, onConfirm, onClose, colors,
  minYear = 1990,
  maxYear = new Date().getFullYear() + 1,
}: YearRangeModalProps) {
  const defaultFrom = minYear;
  const defaultTo = maxYear;
  const [from, setFrom] = useState<number>(initialFrom ?? defaultFrom);
  const [to, setTo] = useState<number>(initialTo ?? defaultTo);

  useEffect(() => {
    if (visible) {
      setFrom(initialFrom ?? defaultFrom);
      setTo(initialTo ?? defaultTo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleConfirm = () => {
    // Auto-correct ordering so "from" never exceeds "to".
    const f = Math.min(from, to);
    const t = Math.max(from, to);
    onConfirm(f, t);
    onClose();
  };

  const handleClear = () => {
    onConfirm(null, null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.background }]} testID="year-range-modal">
          {/* Header */}
          <View style={styles.handle} />
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={handleClear} testID="year-range-clear">
              <Text style={[styles.headerSide, { color: colors.textSecondary }]}>Сбросить</Text>
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Год выпуска</Text>
            <TouchableOpacity onPress={handleConfirm} testID="year-range-confirm">
              <Text style={[styles.headerSide, { color: colors.primary, fontWeight: '800' }]}>Готово</Text>
            </TouchableOpacity>
          </View>

          {/* Two-column wheel */}
          <View style={styles.wheelsRow}>
            <View style={styles.wheelCol}>
              <Text style={[styles.colLabel, { color: colors.textSecondary }]}>от</Text>
              <YearWheelPicker
                value={from}
                onChange={setFrom}
                minYear={minYear}
                maxYear={maxYear}
                colors={colors}
              />
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.wheelCol}>
              <Text style={[styles.colLabel, { color: colors.textSecondary }]}>до</Text>
              <YearWheelPicker
                value={to}
                onChange={setTo}
                minYear={minYear}
                maxYear={maxYear}
                colors={colors}
              />
            </View>
          </View>

          {/* Confirm CTA (also accessible via header "Готово") */}
          <TouchableOpacity
            testID="year-range-cta"
            onPress={handleConfirm}
            style={[styles.cta, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark" size={20} color="#000" />
            <Text style={styles.ctaTxt}>{from} — {to}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(127,127,127,0.35)',
    marginTop: 8,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: { fontSize: 15, fontWeight: '600' },
  headerTitle: { fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  wheelsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  wheelCol: {
    flex: 1,
    alignItems: 'center',
  },
  colLabel: { fontSize: 13, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginHorizontal: 8 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 16,
    height: 50,
    borderRadius: 14,
  },
  ctaTxt: { fontSize: 16, fontWeight: '900', color: '#000', letterSpacing: -0.2 },
});
