/**
 * Sprint 5 — Post-Escrow Review screen.
 *
 * Triggered by notification action_url after escrow_released:
 *   /review/post-escrow?requestId=...
 *
 * UX:
 *   1. Loads pair status (am I customer or provider? did I already submit?)
 *   2. Star rating (1-5)
 *   3. Tag chips (positive for rating >= 4, negative for rating <= 3)
 *   4. Comment (optional)
 *   5. Submit → blind reveal until counterparty submits or 72h pass
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { trustAPI } from '../../src/services/api';
import { useRequireAuth } from '../../src/hooks/useRequireAuth';
import { AuthRequiredModal } from '../../src/components/AuthRequiredModal';

const POSITIVE_TAGS = [
  { key: 'fast', label: 'Быстро' },
  { key: 'professional', label: 'Профессионально' },
  { key: 'quality_work', label: 'Качество' },
  { key: 'communicative', label: 'На связи' },
  { key: 'punctual', label: 'Пунктуально' },
  { key: 'clean', label: 'Чисто' },
];
const NEGATIVE_TAGS = [
  { key: 'late', label: 'Опоздал' },
  { key: 'expensive', label: 'Дорого' },
  { key: 'rude', label: 'Грубо' },
  { key: 'incomplete', label: 'Не доделал' },
];

export default function PostEscrowReviewScreen() {
  const router = useRouter();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const { requireAuth, authModalVisible, closeAuthModal, authReason } = useRequireAuth();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pair, setPair] = useState<any | null>(null);
  const [authorRole, setAuthorRole] = useState<'customer' | 'provider' | null>(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);

  const [rating, setRating] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');

  const availableTags = rating <= 3 && rating > 0 ? NEGATIVE_TAGS : POSITIVE_TAGS;

  useEffect(() => {
    void loadState();
  }, [requestId]);

  async function loadState() {
    if (!requestId) {
      setLoading(false);
      return;
    }
    try {
      const { data } = await trustAPI.byRequest(String(requestId));
      setPair(data);
      // Find which side is me.
      const myReview = (data.reviews || []).find((r: any) => r.authorId);
      if (myReview) {
        setAuthorRole(myReview.authorRole);
        setAlreadySubmitted(true);
      } else {
        // Look at masked counterparty to infer my role.
        const counter = (data.reviews || [])[0];
        if (counter) {
          setAuthorRole(counter.authorRole === 'customer' ? 'provider' : 'customer');
        }
      }
    } catch (e: any) {
      // 401 → require auth
      if (e?.response?.status === 401) {
        requireAuth(() => loadState(), {
          intent: 'review_post_escrow',
          reason: 'Войдите, чтобы оставить отзыв.',
          params: { requestId: String(requestId || '') },
        });
      }
    } finally {
      setLoading(false);
    }
  }

  function toggleTag(key: string) {
    setSelectedTags((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : prev.length >= 6 ? prev : [...prev, key]
    );
  }

  async function handleSubmit() {
    if (rating < 1) {
      Alert.alert('Оценка обязательна', 'Выберите от 1 до 5 звёзд');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await trustAPI.submit({
        requestId: String(requestId),
        rating,
        tags: selectedTags,
        comment: comment.trim() || undefined,
      });
      const revealMsg = data.revealed
        ? 'Отзывы открыты для обеих сторон!'
        : 'Ваш отзыв принят. Он откроется, как только вторая сторона тоже оценит (или через 72 ч).';
      Alert.alert('Спасибо!', revealMsg, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || 'Не удалось отправить отзыв';
      Alert.alert('Ошибка', String(msg));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#FFD23F" size="large" style={{ marginTop: 100 }} />
      </SafeAreaView>
    );
  }

  if (alreadySubmitted) {
    return (
      <SafeAreaView style={styles.container}>
        <Header title="Отзыв оставлен" onBack={() => router.back()} />
        <View style={styles.centerBox}>
          <Ionicons name="checkmark-circle" size={64} color="#34D399" />
          <Text style={styles.heading}>Вы уже оценили эту сделку</Text>
          <Text style={styles.muted}>
            Отзывы открываются, как только обе стороны оставят оценку, или через 72 часа.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const targetLabel = authorRole === 'provider' ? 'клиента' : 'исполнителя';

  return (
    <SafeAreaView style={styles.container}>
      <Header title={`Оцените ${targetLabel}`} onBack={() => router.back()} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.subtitle}>
            Сделка завершена. Оцените {targetLabel}, чтобы оба отзыва открылись.
          </Text>

          {/* Stars */}
          <View style={styles.starsRow} testID="review-stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <TouchableOpacity
                key={n}
                onPress={() => {
                  setRating(n);
                  setSelectedTags([]);
                }}
                testID={`star-${n}`}
                hitSlop={6}
              >
                <Ionicons
                  name={n <= rating ? 'star' : 'star-outline'}
                  size={44}
                  color={n <= rating ? '#FFD23F' : '#6B7280'}
                />
              </TouchableOpacity>
            ))}
          </View>
          {rating > 0 && (
            <Text style={styles.ratingLabel}>
              {rating === 5
                ? 'Отлично'
                : rating === 4
                ? 'Хорошо'
                : rating === 3
                ? 'Нормально'
                : rating === 2
                ? 'Так себе'
                : 'Плохо'}
            </Text>
          )}

          {/* Tags */}
          {rating > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {rating <= 3 ? 'Что пошло не так?' : 'Что понравилось?'}
              </Text>
              <View style={styles.tagsWrap}>
                {availableTags.map((t) => {
                  const active = selectedTags.includes(t.key);
                  return (
                    <TouchableOpacity
                      key={t.key}
                      onPress={() => toggleTag(t.key)}
                      style={[styles.chip, active && styles.chipActive]}
                      testID={`tag-${t.key}`}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Comment */}
          {rating > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Комментарий (необязательно)</Text>
              <TextInput
                value={comment}
                onChangeText={setComment}
                multiline
                maxLength={1000}
                placeholder="Поделитесь деталями…"
                placeholderTextColor="#6B7280"
                style={styles.commentInput}
                testID="review-comment"
              />
              <Text style={styles.counter}>{comment.length}/1000</Text>
            </View>
          )}

          <View style={styles.disclosure}>
            <Ionicons name="lock-closed" size={14} color="#9CA3AF" />
            <Text style={styles.disclosureText}>
              Отзыв открывается только когда обе стороны оценили, или через 72 ч.
            </Text>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            disabled={rating < 1 || submitting}
            onPress={handleSubmit}
            style={[styles.submit, (rating < 1 || submitting) && styles.submitDisabled]}
            testID="review-submit-btn"
          >
            {submitting ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={styles.submitText}>Отправить отзыв</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <AuthRequiredModal
        visible={authModalVisible}
        onClose={closeAuthModal}
        reason={authReason}
      />
    </SafeAreaView>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} hitSlop={8} testID="review-back-btn">
        <Ionicons name="chevron-back" size={26} color="#fff" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={{ width: 26 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#1f2937',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  scroll: { padding: 20, paddingBottom: 40 },
  subtitle: { color: '#9CA3AF', fontSize: 14, marginBottom: 28, textAlign: 'center' },
  starsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24 },
  ratingLabel: { color: '#FFD23F', fontSize: 16, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  section: { marginTop: 28 },
  sectionTitle: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 12 },
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#1f2937',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#374151',
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: '#FFD23F22', borderColor: '#FFD23F' },
  chipText: { color: '#E5E7EB', fontSize: 13 },
  chipTextActive: { color: '#FFD23F', fontWeight: '600' },
  commentInput: {
    backgroundColor: '#1f2937',
    color: '#fff',
    borderRadius: 12,
    padding: 12,
    minHeight: 100,
    textAlignVertical: 'top',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#374151',
  },
  counter: { color: '#6B7280', fontSize: 12, textAlign: 'right', marginTop: 4 },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 24,
    paddingHorizontal: 8,
  },
  disclosureText: { color: '#9CA3AF', fontSize: 12, flex: 1 },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#1f2937',
  },
  submit: {
    backgroundColor: '#FFD23F',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#000', fontSize: 16, fontWeight: '700' },
  centerBox: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  heading: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 20, textAlign: 'center' },
  muted: { color: '#9CA3AF', fontSize: 14, marginTop: 12, textAlign: 'center', lineHeight: 20 },
});
