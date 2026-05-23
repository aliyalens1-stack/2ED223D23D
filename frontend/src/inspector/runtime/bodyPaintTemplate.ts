/**
 * Body & Paint inspection section — R1 proof-of-concept template.
 *
 * NOT a generic form engine. This is hand-curated data describing one
 * cognitive section of a pre-purchase car inspection. When R4 expands to
 * the remaining 14 sections, each gets its own equivalent file — NOT a
 * config-driven renderer.
 *
 * Why purpose-built (not abstracted):
 *   - Inspector latency matters more than developer DRY
 *   - Each section has its own physical workflow (cold/warm, lifted/down)
 *   - Auto-severity rules are domain-specific, not generalisable
 *
 * Mirror of backend `app/auto_requests/checklist.py::CHECKLIST` body_paint
 * group — same item keys so server accepts the submission unchanged.
 */

export type ItemType = 'paint_depth' | 'severity' | 'boolean';
export type ItemSeverity = 'ok' | 'warning' | 'critical' | 'not_checked';

export interface BodyPaintItem {
  /** Mirrors backend checklist.CHECKLIST key. */
  key: string;
  /** Inspector-facing label (ru). */
  label: string;
  /** What kind of physical interaction this item is. */
  type: ItemType;
  /** Numeric unit if type=paint_depth. */
  unit?: 'µm';
  /** Photo strongly recommended if severity ≥ warning. */
  photoRequiredIfWarning?: boolean;
  /** Help text shown when inspector taps the (?) icon. */
  help?: string;
  /** Auto-severity threshold for paint_depth items. */
  autoSeverity?: {
    warningAbove: number;   // µm
    criticalAbove: number;  // µm
  };
}

export const BODY_PAINT_SECTION = {
  key: 'body_paint',
  title: 'Кузов и покрас',
  order: 2,
  // Items in execution order — inspector walks around the car.
  // Front → side → rear, left first.
  items: [
    {
      key: 'paint_depth_front_l',
      label: 'Левое переднее крыло · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      help: 'Заводская норма 80–150 µm. 150–250 — освежение. 300+ — ремонт. 500+ — перекрас панели.',
      autoSeverity: { warningAbove: 300, criticalAbove: 500 },
    },
    {
      key: 'paint_depth_front_r',
      label: 'Правое переднее крыло · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      help: 'Заводская норма 80–150 µm. 150–250 — освежение. 300+ — ремонт.',
      autoSeverity: { warningAbove: 300, criticalAbove: 500 },
    },
    {
      key: 'paint_depth_door_l',
      label: 'Левая передняя дверь · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      autoSeverity: { warningAbove: 300, criticalAbove: 500 },
    },
    {
      key: 'paint_depth_door_r',
      label: 'Правая передняя дверь · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      autoSeverity: { warningAbove: 300, criticalAbove: 500 },
    },
    {
      key: 'paint_depth_roof',
      label: 'Крыша · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      help: 'Крыша редко перекрашивается. 300+ µm здесь — серьёзный сигнал (град, кувырок).',
      autoSeverity: { warningAbove: 250, criticalAbove: 400 },
    },
    {
      key: 'paint_depth_quarter_l',
      label: 'Левая задняя четверть · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      autoSeverity: { warningAbove: 300, criticalAbove: 500 },
    },
    {
      key: 'paint_depth_quarter_r',
      label: 'Правая задняя четверть · ЛКП',
      type: 'paint_depth' as ItemType,
      unit: 'µm',
      photoRequiredIfWarning: true,
      autoSeverity: { warningAbove: 300, criticalAbove: 500 },
    },
    {
      key: 'bumper_front_visual',
      label: 'Передний бампер',
      type: 'severity' as ItemType,
      photoRequiredIfWarning: true,
      help: 'Сколы, трещины, отсутствие креплений, цветовое расхождение.',
    },
    {
      key: 'bumper_rear_visual',
      label: 'Задний бампер',
      type: 'severity' as ItemType,
      photoRequiredIfWarning: true,
    },
    {
      key: 'rust_visible',
      label: 'Видимая коррозия',
      type: 'severity' as ItemType,
      photoRequiredIfWarning: true,
      help: 'Пороги, арки, заднее окно, рамка лобового, петли дверей.',
    },
    {
      key: 'panel_gaps',
      label: 'Зазоры кузова',
      type: 'severity' as ItemType,
      photoRequiredIfWarning: true,
      help: 'Неравномерные зазоры между панелями = последствие удара/ремонта.',
    },
  ] as const,
} as const;

export type BodyPaintItemKey = (typeof BODY_PAINT_SECTION.items)[number]['key'];

/**
 * Compute auto-severity from numeric measurement.
 * Returns null if no auto-rule applies (inspector must pick manually).
 */
export function autoSeverityForPaintDepth(
  item: BodyPaintItem,
  value: number | undefined,
): ItemSeverity | null {
  if (!item.autoSeverity || typeof value !== 'number' || isNaN(value)) return null;
  if (value > item.autoSeverity.criticalAbove) return 'critical';
  if (value > item.autoSeverity.warningAbove) return 'warning';
  return 'ok';
}
