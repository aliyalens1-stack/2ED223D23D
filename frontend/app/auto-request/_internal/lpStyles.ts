/**
 * auto-request — link-preview styles.
 *
 * Visually-rich card used by `LinkPreview.tsx`. Kept in its own sheet so
 * cosmetic tweaks (image height, chip radius, delta-pill colors) can
 * land without churning the main `styles.ts`.
 */
import { StyleSheet } from 'react-native';

export const lpStyles = StyleSheet.create({
  // Loading
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  loadingText: { fontSize: 13, fontWeight: '600' },
  // Parsed card
  card: { marginTop: 12, borderRadius: 16, borderWidth: 1.5, overflow: 'hidden' },
  image: { width: '100%', height: 160 },
  imagePlaceholder: { width: '100%', height: 110, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 14, gap: 8 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  checkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  checkBadgeText: { fontSize: 11, fontWeight: '700' },
  sourceTxt: { fontSize: 11, fontWeight: '600', textTransform: 'lowercase' },
  title: { fontSize: 17, fontWeight: '800', lineHeight: 22, marginTop: 2 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  metaChipTxt: { fontSize: 12, fontWeight: '600' },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: 8,
  },
  priceTxt: { fontSize: 22, fontWeight: '900', letterSpacing: -0.3 },
  deltaPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1.5 },
  deltaTxt: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  ctaTxt: { fontSize: 13, fontWeight: '800' },
  // Failed fallback
  failedBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  failedIconBox: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  failedTitle: { fontSize: 13, fontWeight: '700' },
  failedSub: { fontSize: 12, marginTop: 2 },
});
