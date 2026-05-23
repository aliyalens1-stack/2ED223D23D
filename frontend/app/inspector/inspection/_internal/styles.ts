/**
 * Inspector inspection workflow — StyleSheet.
 *
 * Extracted from the screen file. No theme tokens here — colors are
 * applied inline at the call site via theme context. This keeps the
 * sheet a single source of geometry/typography truth.
 */
import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
  },
  backBtn: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  body: { paddingHorizontal: 16, paddingBottom: 32 },
  errorText: { fontSize: 14, textAlign: 'center', marginTop: 12 },

  // Progress
  progressCard: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 14 },
  progressTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  progressTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  progressN: { fontSize: 14, fontWeight: '700' },
  progressTrack: { height: 8, borderRadius: 4 },
  progressFill: { height: 8, borderRadius: 4 },
  flagsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  flag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  flagText: { fontSize: 11, fontWeight: '700' },

  // UX-4D — Inspector TimelineRail (workflow lens, ambient, collapsible)
  tlCard: { borderRadius: 12, borderWidth: 1, marginBottom: 14, overflow: 'hidden' },
  tlHead: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  tlHeadDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  tlHeadTitle: { fontSize: 13, fontWeight: '700' },
  tlHeadSub: { fontSize: 11, marginTop: 2 },
  tlBody: { borderTopWidth: 1, paddingTop: 10, paddingHorizontal: 12, paddingBottom: 4 },
  tlRow: { flexDirection: 'row' },
  tlRowAxis: { width: 18, alignItems: 'center' },
  tlRowDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  tlRowLine: { width: 1, flex: 1, marginTop: 2 },
  tlRowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tlRowTitle: { fontSize: 12, fontWeight: '600', flex: 1 },
  tlRowWhen: { fontSize: 11, marginLeft: 8 },

  // OCR-1 — pending OCR card (per item, replaces "captured photo" silence)
  ocrCard: { marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1 },
  ocrHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  ocrHeadTitle: { fontSize: 12, fontWeight: '700', flex: 1 },
  ocrConf: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  ocrConfText: { fontSize: 10, fontWeight: '800' },
  ocrValue: {
    fontSize: 18, fontWeight: '700',
    letterSpacing: 1, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    paddingVertical: 6,
  },
  ocrInput: {
    fontSize: 16, fontWeight: '700',
    letterSpacing: 1, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 8, borderWidth: 1,
  },
  ocrActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  ocrBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, flex: 1,
  },
  ocrBtnText: { fontSize: 13, fontWeight: '700' },
  ocrBtnGhost: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: 8, borderWidth: 1, flex: 1,
  },
  ocrBtnGhostText: { fontSize: 13, fontWeight: '600' },

  // Section row
  sectionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 8,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700' },
  sectionMeta: { fontSize: 12, marginTop: 3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  // UX-4C step 2 — section navigator rollup chips
  sectionChips: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 2 },
  sectionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 999, borderWidth: 1,
    minWidth: 22, justifyContent: 'center',
  },
  sectionChipText: { fontSize: 11, fontWeight: '700' },

  // CTA
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14 },
  ctaText: { fontSize: 15, fontWeight: '700' },

  // Item card (detail view)
  itemCard: { padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 10 },
  itemHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  itemLabel: { fontSize: 14, fontWeight: '700', lineHeight: 18 },
  requiredPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999 },
  requiredText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  // UX-4C inline guidance line (per-item).
  gapLine: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1,
    marginBottom: 10,
  },
  gapText: { fontSize: 12, fontWeight: '500', flex: 1 },

  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  statusBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  statusBtnText: { fontSize: 12, fontWeight: '600' },

  noteInput: { borderRadius: 10, padding: 10, fontSize: 13, minHeight: 60, borderWidth: 1, marginBottom: 10 },

  mediaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mediaThumb: { width: 50, height: 50, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  mediaAdd: {
    minWidth: 64, height: 50, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1.5, borderStyle: 'dashed',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  mediaAddText: { fontSize: 12, fontWeight: '700' },

  // Summary view (UX-3B step 6-7)
  summaryBanner: { alignItems: 'center', padding: 18, borderRadius: 16, borderWidth: 1.5, gap: 8, marginBottom: 14 },
  summaryIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  summaryRec: { fontSize: 18, fontWeight: '800' },
  summaryScore: { fontSize: 36, fontWeight: '800', marginTop: 4 },
  summaryScoreHint: { fontSize: 16, fontWeight: '500' },
  summaryHint: { fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 4 },
  summaryBlock: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 12 },
  summaryBlockHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryBlockTitle: { fontSize: 13, fontWeight: '800', flex: 1 },
  summaryCountPill: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  summaryCountText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  summaryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  summaryBullet: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  summaryRowLabel: { fontSize: 13, fontWeight: '600' },
  summaryRowNote: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  summaryGoodList: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  summaryActions: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 8 },
  summaryEditBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 14, borderRadius: 14, borderWidth: 1,
  },
  summaryConfirmBtn: {
    flex: 1.4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 14, borderRadius: 14,
  },
});
