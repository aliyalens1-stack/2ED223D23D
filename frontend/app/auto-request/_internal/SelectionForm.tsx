/**
 * auto-request — Selection flow form (filters-based).
 *
 * Brand · Model · Budget · Year range · Fuel · Transmission · Mileage
 * cap · Country · City · Comment. Wraps three searchable modals
 * (brand / model / year) — see `src/components/*PickerModal.tsx`.
 *
 * Multi-city pre-selection is enabled in this flow.
 */
import React, { useMemo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import BrandPickerModal from '../../../src/components/BrandPickerModal';
import ModelPickerModal from '../../../src/components/ModelPickerModal';
import YearRangeModal from '../../../src/components/YearRangeModal';
import { CAR_BRANDS } from '../../../src/constants/carCatalogue';
import { styles } from './styles';
import { Label } from './primitives';
import { ChipRow } from './ChipRow';
import { CountryRow } from './CountryRow';
import { CityField } from './CityField';
import { FUEL_OPTIONS, TRANSMISSION_OPTIONS } from './constants';
import type { ColorsLike, Country } from './types';

interface Props {
  colors: ColorsLike;
  brand: string;
  setBrand: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  budget: string;
  setBudget: (v: string) => void;
  yearFrom: string;
  setYearFrom: (v: string) => void;
  yearTo: string;
  setYearTo: (v: string) => void;
  fuel: string;
  setFuel: (v: string) => void;
  transmission: string;
  setTransmission: (v: string) => void;
  mileageMax: string;
  setMileageMax: (v: string) => void;
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

export function SelectionForm(props: Props) {
  const { t } = useTranslation();
  const {
    colors, brand, setBrand, model, setModel, budget, setBudget,
    yearFrom, setYearFrom, yearTo, setYearTo, fuel, setFuel,
    transmission, setTransmission, mileageMax, setMileageMax,
    country, geoCountries, openCountryModal,
    selectedCitiesText, openCityModal, comment, setComment, cities,
  } = props;

  const [brandModal, setBrandModal] = useState(false);
  const [modelModal, setModelModal] = useState(false);
  const [yearModal, setYearModal] = useState(false);

  const brandId = (brand || '').trim().toLowerCase();
  const brandDisplayName = useMemo(() => {
    const found = CAR_BRANDS.find((b) => b.id === brandId);
    return found ? found.name : brand;
  }, [brand, brandId]);

  const yearFromNum = yearFrom ? Number(yearFrom) : null;
  const yearToNum = yearTo ? Number(yearTo) : null;
  const yearLabel = (yearFromNum && yearToNum)
    ? `${yearFromNum} — ${yearToNum}`
    : (yearFromNum ? `${t('create.year_from_prefix', { defaultValue: 'from' })} ${yearFromNum}` : (yearToNum ? `${t('create.year_to_prefix', { defaultValue: 'to' })} ${yearToNum}` : ''));

  return (
    <>
      {/* Brand / Model — tappable cards opening searchable modals */}
      <View style={styles.row2}>
        <View style={{ flex: 1 }}>
          <Label colors={colors}>{t('create.label_brand', { defaultValue: 'Brand *' })}</Label>
          <TouchableOpacity
            testID="create-pick-brand"
            onPress={() => setBrandModal(true)}
            activeOpacity={0.7}
            style={[styles.pickerField, { backgroundColor: colors.card, borderColor: brand ? colors.primary : colors.border }]}
          >
            <Text
              style={[styles.pickerFieldText, { color: brand ? colors.text : colors.textSecondary }]}
              numberOfLines={1}
            >
              {brandDisplayName || t('create.placeholder_brand', { defaultValue: 'Select brand' })}
            </Text>
            <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1 }}>
          <Label colors={colors}>{t('create.label_model', { defaultValue: 'Model *' })}</Label>
          <TouchableOpacity
            testID="create-pick-model"
            onPress={() => {
              if (!brand) {
                setBrandModal(true); // force brand selection first
                return;
              }
              setModelModal(true);
            }}
            activeOpacity={0.7}
            disabled={!brand}
            style={[
              styles.pickerField,
              {
                backgroundColor: colors.card,
                borderColor: model ? colors.primary : colors.border,
                opacity: brand ? 1 : 0.55,
              },
            ]}
          >
            <Text
              style={[styles.pickerFieldText, { color: model ? colors.text : colors.textSecondary }]}
              numberOfLines={1}
            >
              {model || (brand
                ? t('create.placeholder_model', { defaultValue: 'Select model' })
                : t('create.placeholder_model_disabled', { defaultValue: 'Pick brand first' }))}
            </Text>
            <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Budget */}
      <Label colors={colors}>{t('create.label_budget', { defaultValue: 'Budget, € *' })}</Label>
      <View style={[styles.numericInputBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.numericPrefix, { color: colors.textSecondary }]}>€</Text>
        <TextInput
          testID="create-input-budget"
          value={budget}
          onChangeText={(v) => setBudget(v.replace(/[^0-9]/g, ''))}
          placeholder="20 000"
          placeholderTextColor={colors.textSecondary}
          keyboardType="numeric"
          style={[styles.numericInput, { color: colors.text }]}
        />
      </View>

      {/* Year range */}
      <Label colors={colors}>{t('create.label_year_range', { defaultValue: 'Year' })}</Label>
      <TouchableOpacity
        testID="create-pick-year"
        onPress={() => setYearModal(true)}
        activeOpacity={0.7}
        style={[styles.pickerField, { backgroundColor: colors.card, borderColor: yearLabel ? colors.primary : colors.border }]}
      >
        <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
        <Text
          style={[styles.pickerFieldText, { color: yearLabel ? colors.text : colors.textSecondary, marginLeft: 8 }]}
          numberOfLines={1}
        >
          {yearLabel || t('create.placeholder_year_any', { defaultValue: 'Any year' })}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
      </TouchableOpacity>

      {/* Fuel / Transmission */}
      <Label colors={colors}>{t('create.label_fuel', { defaultValue: 'Fuel' })}</Label>
      <ChipRow options={FUEL_OPTIONS as any} value={fuel} onChange={setFuel} colors={colors} testIdPrefix="create-fuel" allowClear />

      <Label colors={colors}>{t('create.label_transmission', { defaultValue: 'Transmission' })}</Label>
      <ChipRow options={TRANSMISSION_OPTIONS as any} value={transmission} onChange={setTransmission} colors={colors} testIdPrefix="create-trans" allowClear />

      {/* Mileage cap */}
      <Label colors={colors}>{t('create.label_mileage_max', { defaultValue: 'Max mileage, km' })}</Label>
      <View style={[styles.numericInputBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="speedometer-outline" size={18} color={colors.textSecondary} />
        <TextInput
          testID="create-input-mileage"
          value={mileageMax}
          onChangeText={(v) => setMileageMax(v.replace(/[^0-9]/g, ''))}
          placeholder="120 000"
          placeholderTextColor={colors.textSecondary}
          keyboardType="numeric"
          style={[styles.numericInput, { color: colors.text, marginLeft: 8 }]}
        />
        <Text style={[styles.numericPrefix, { color: colors.textSecondary }]}>{t('create.mileage_unit', { defaultValue: 'km' })}</Text>
      </View>

      <CountryRow colors={colors} country={country} geoCountries={geoCountries} openCountryModal={openCountryModal} />
      <CityField
        colors={colors}
        text={selectedCitiesText}
        onPress={openCityModal}
        selected={cities.length > 0}
        hint={t('create.hint_cities_multi', { defaultValue: 'You can pick multiple cities — a separate inspection per city' })}
      />

      <Label colors={colors}>{t('create.label_comment', { defaultValue: 'Comment (optional)' })}</Label>
      <TextInput
        testID="create-input-comment"
        value={comment}
        onChangeText={setComment}
        placeholder={t('create.placeholder_comment_selection', { defaultValue: 'What matters to you? Family, fuel-efficient, winter tires...' })}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, styles.textArea, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
        multiline
        numberOfLines={3}
      />

      {/* Modals */}
      <BrandPickerModal
        visible={brandModal}
        value={brandId}
        colors={colors as any}
        onClose={() => setBrandModal(false)}
        onSelect={(id /* lowercase id */, _name) => {
          setBrand(id);   // store id; display name resolved via CAR_BRANDS
          setModel('');   // brand changed → reset model
        }}
      />
      <ModelPickerModal
        visible={modelModal}
        brandId={brandId}
        brandName={brandDisplayName || ''}
        value={model}
        colors={colors as any}
        onClose={() => setModelModal(false)}
        onSelect={(m) => setModel(m)}
      />
      <YearRangeModal
        visible={yearModal}
        initialFrom={yearFromNum}
        initialTo={yearToNum}
        colors={colors as any}
        onClose={() => setYearModal(false)}
        onConfirm={(f, to) => {
          setYearFrom(f == null ? '' : String(f));
          setYearTo(to == null ? '' : String(to));
        }}
      />
    </>
  );
}
