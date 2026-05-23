/**
 * auto-request — Inspection flow form (link-based).
 *
 * Single-input form: listing link → debounced canonical parse →
 * preview card. Country + city + urgency + optional comment.
 */
import React, { useEffect, useState } from 'react';
import { TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '../../../src/services/api';
import { styles } from './styles';
import { Hint, Label } from './primitives';
import { ChipRow } from './ChipRow';
import { CountryRow } from './CountryRow';
import { CityField } from './CityField';
import { LinkPreview } from './LinkPreview';
import { URGENCY_OPTIONS } from './constants';
import type { ColorsLike, Country } from './types';

interface Props {
  colors: ColorsLike;
  link: string;
  setLink: (v: string) => void;
  urgency: string;
  setUrgency: (v: string) => void;
  country: string;
  setCountry: (v: string) => void;
  geoCountries: Country[];
  openCountryModal: () => void;
  cities: string[];
  selectedCitiesText: string;
  openCityModal: () => void;
  comment: string;
  setComment: (v: string) => void;
}

export function InspectionForm(props: Props) {
  const { t } = useTranslation();
  const {
    colors, link, setLink, urgency, setUrgency, country, geoCountries,
    openCountryModal, selectedCitiesText, openCityModal, comment, setComment, cities,
  } = props;

  // P1.2 — Debounced link preview (canonical envelope from /api/parse/car-link).
  const [preview, setPreview] = useState<any | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    const v = (link || '').trim();
    if (!v || v.length < 12) { setPreview(null); return; }
    if (!/^https?:\/\//i.test(v)) { setPreview(null); return; }
    let alive = true;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      api.post('/parse/car-link', { url: v })
        .then((r) => { if (alive) setPreview(r.data); })
        .catch(() => {
          // Network failure → synthesize a canonical envelope so the
          // surface still flows through the shared classifier. Soft by
          // construction (link stays accepted).
          if (alive) setPreview({
            canonical: {
              ok: false,
              source: null,
              sourceUrl: v,
              parseCompleteness: 'weak',
              degradedReason: 'fetch_failed',
            },
          });
        })
        .finally(() => { if (alive) setPreviewLoading(false); });
    }, 700);
    return () => { alive = false; clearTimeout(timer); };
  }, [link]);

  return (
    <>
      <Label colors={colors}>{t('create.label_link') || 'Listing link *'}</Label>
      <TextInput
        testID="create-input-link"
        value={link}
        onChangeText={setLink}
        placeholder={t('create.placeholder_link') || 'https://suchen.mobile.de/... or autoscout24 / kleinanzeigen'}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Hint colors={colors}>{t('create.hint_link_sources') || 'We support mobile.de · autoscout24 · kleinanzeigen · dealer sites'}</Hint>

      <LinkPreview colors={colors} loading={previewLoading} preview={preview} />

      <CountryRow colors={colors} country={country} geoCountries={geoCountries} openCountryModal={openCountryModal} />
      <CityField colors={colors} text={selectedCitiesText} onPress={openCityModal} selected={cities.length > 0} />

      <Label colors={colors}>{t('create.label_urgency') || 'Urgency'}</Label>
      <ChipRow
        options={URGENCY_OPTIONS as any}
        value={urgency}
        onChange={setUrgency}
        colors={colors}
        testIdPrefix="create-urgency"
      />

      <Label colors={colors}>{t('create.label_comment') || 'Comment (optional)'}</Label>
      <TextInput
        testID="create-input-comment"
        value={comment}
        onChangeText={setComment}
        placeholder={t('create.placeholder_comment_inspection') || 'What is most important to check?'}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, styles.textArea, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
        multiline
        numberOfLines={3}
      />
    </>
  );
}
