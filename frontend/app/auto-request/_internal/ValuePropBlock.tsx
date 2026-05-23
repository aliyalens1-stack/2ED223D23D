/**
 * auto-request — Value Proposition block (STEP-1 pre-payment trust).
 *
 * Shows BEFORE submit so the user understands exactly what they get for
 * €149/€399. Reduces "is this a scam?" friction and lifts conversion.
 *
 * Content is i18n-driven (`value_prop.*` namespace) — adjust copy without
 * code changes.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { styles } from './styles';
import type { ColorsLike } from './types';
import i18n from '../../../src/i18n';

export function ValuePropBlock({ colors }: { colors: ColorsLike }) {
  const { t } = useTranslation();
  const items: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; sub: string }[] = [
    { icon: 'shield-checkmark', title: i18n.t('value_prop.p1_title'), sub: i18n.t('value_prop.p1_sub') },
    { icon: 'camera',           title: i18n.t('value_prop.p2_title'), sub: i18n.t('value_prop.p2_sub') },
    { icon: 'cog',              title: i18n.t('value_prop.p3_title'), sub: i18n.t('value_prop.p3_sub') },
    { icon: 'analytics',        title: i18n.t('value_prop.p4_title'), sub: i18n.t('value_prop.p4_sub') },
    { icon: 'time',             title: i18n.t('value_prop.p5_title'), sub: i18n.t('value_prop.p5_sub') },
    { icon: 'lock-closed',      title: i18n.t('value_prop.p6_title'), sub: i18n.t('value_prop.p6_sub') },
  ];
  const checkItems = [
    i18n.t('value_prop.check_engine'),
    i18n.t('value_prop.check_gearbox'),
    i18n.t('value_prop.check_body'),
    i18n.t('value_prop.check_mileage'),
    i18n.t('value_prop.check_obd'),
    i18n.t('value_prop.check_testdrive'),
  ];

  return (
    <View testID="create-value-prop" style={[styles.vpBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text testID="create-value-prop-kicker" style={[styles.vpKicker, { color: colors.primary }]}>
        {t('value_prop.kicker')}
      </Text>
      <Text style={[styles.vpTitle, { color: colors.text }]}>{t('value_prop.title')}</Text>
      {items.map((item, idx) => (
        <View key={idx} style={styles.vpRow} testID={`create-value-prop-item-${idx}`}>
          <View style={[styles.vpIconBox, { backgroundColor: 'rgba(245,184,0,0.15)' }]}>
            <Ionicons name={item.icon} size={16} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.vpItemTitle, { color: colors.text }]}>{item.title}</Text>
            <Text style={[styles.vpItemSub, { color: colors.textSecondary }]}>{item.sub}</Text>
          </View>
        </View>
      ))}

      <View testID="create-what-we-check" style={[styles.vpCheckBox, { borderTopColor: colors.border }]}>
        <Text style={[styles.vpCheckTitle, { color: colors.text }]}>
          {t('value_prop.check_title')}
        </Text>
        {checkItems.map((label, idx) => (
          <View key={idx} testID={`create-check-item-${idx}`} style={styles.vpCheckRow}>
            <Ionicons name="checkmark-circle" size={14} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[styles.vpCheckText, { color: colors.textSecondary }]}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
