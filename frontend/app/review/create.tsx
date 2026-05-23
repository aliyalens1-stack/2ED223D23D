import React, { useState } from 'react';
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
import { reviewsAPI } from '../../src/services/api';
import { useRequireAuth } from '../../src/hooks/useRequireAuth';
import { AuthRequiredModal } from '../../src/components/AuthRequiredModal';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

export default function CreateReviewScreen() {
  const router = useRouter();
  const { bookingId, orgName, serviceName } = useLocalSearchParams();
  
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Sprint Auth-2: review create — protected
  const { requireAuth, authModalVisible, closeAuthModal, authReason } = useRequireAuth();

  const handleSubmit = async () => {
    if (rating < 1 || rating > 5) {
      Alert.alert('Ошибка', 'Выберите оценку от 1 до 5');
      return;
    }

    requireAuth(
      async () => { await doSubmit(); },
      {
        intent: 'review_create',
        reason: 'Войдите, чтобы оставить отзыв. Мы вернём вас сюда после входа.',
        params: {
          bookingId: String(bookingId || ''),
          orgName: String(orgName || ''),
          serviceName: String(serviceName || ''),
        },
      }
    );
  };

  const doSubmit = async () => {
    setSubmitting(true);
    try {
      await reviewsAPI.create({
        bookingId: bookingId as string,
        rating,
        comment: comment.trim() || undefined,
      });
      
      Alert.alert(
        'Спасибо!',
        'Ваш отзыв успешно отправлен',
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error: any) {
      const msg = error.response?.data?.message || 'Не удалось отправить отзыв';
      Alert.alert('Ошибка', Array.isArray(msg) ? msg[0] : msg);
    } finally {
      setSubmitting(false);
    }
  };

  const getRatingLabel = (r: number) => {
    switch (r) {
      case 1: return 'Ужасно';
      case 2: return 'Плохо';
      case 3: return 'Нормально';
      case 4: return 'Хорошо';
      case 5: return 'Отлично';
      default: return '';
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="close" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Оставить отзыв</Text>
        <View style={{ width: 44 }} />
      </View>

      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {/* Service Info */}
          <View style={styles.serviceCard}>
            <View style={styles.serviceIcon}>
              <Ionicons name="car-sport" size={24} color={colors.brand} />
            </View>
            <View style={styles.serviceInfo}>
              <Text style={styles.serviceName}>{serviceName || 'Услуга'}</Text>
              <Text style={styles.orgName}>{orgName || 'СТО'}</Text>
            </View>
          </View>

          {/* Rating Section */}
          <View style={styles.ratingSection}>
            <Text style={styles.sectionTitle}>Оцените сервис</Text>
            
            <View style={styles.starsRow}>
              {[1, 2, 3, 4, 5].map((star) => (
                <TouchableOpacity
                  key={star}
                  onPress={() => setRating(star)}
                  style={styles.starButton}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={star <= rating ? 'star' : 'star-outline'}
                    size={40}
                    color={star <= rating ? colors.warning : colors.border}
                  />
                </TouchableOpacity>
              ))}
            </View>
            
            <Text style={[
              styles.ratingLabel,
              { color: rating >= 4 ? colors.success : rating >= 3 ? colors.warning : colors.brand }
            ]}>
              {getRatingLabel(rating)}
            </Text>
          </View>

          {/* Comment Section */}
          <View style={styles.commentSection}>
            <Text style={styles.sectionTitle}>Ваш комментарий</Text>
            <Text style={styles.optional}>(необязательно)</Text>
            
            <TextInput
              style={styles.commentInput}
              placeholder="Расскажите о вашем опыте..."
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              value={comment}
              onChangeText={setComment}
              maxLength={500}
            />
            
            <Text style={styles.charCount}>
              {comment.length}/500
            </Text>
          </View>

          {/* Quick Tags */}
          <View style={styles.tagsSection}>
            <Text style={styles.tagsTitle}>Что понравилось?</Text>
            <View style={styles.tagsRow}>
              {['Качество работы', 'Скорость', 'Цена', 'Общение', 'Чистота'].map((tag) => (
                <TouchableOpacity
                  key={tag}
                  style={[
                    styles.tag,
                    comment.includes(tag) && styles.tagActive
                  ]}
                  onPress={() => {
                    if (comment.includes(tag)) {
                      setComment(comment.replace(tag + '. ', '').replace(tag, ''));
                    } else {
                      setComment((comment ? comment + ' ' : '') + tag + '.');
                    }
                  }}
                >
                  <Text style={[
                    styles.tagText,
                    comment.includes(tag) && styles.tagTextActive
                  ]}>
                    {tag}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={{ height: 100 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Submit Button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Ionicons name="send" size={20} color={colors.text} />
              <Text style={styles.submitButtonText}>Отправить отзыв</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
      <AuthRequiredModal
        visible={authModalVisible}
        onClose={closeAuthModal}
        reason={authReason}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundSecondary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardElevated,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.cardElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  serviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardElevated,
    padding: 16,
    borderRadius: 16,
    marginBottom: 24,
  },
  serviceIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#3B82F620',
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceInfo: {
    flex: 1,
    marginLeft: 12,
  },
  serviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  orgName: {
    fontSize: 14,
    color: colors.textMuted,
  },
  ratingSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 16,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  starButton: {
    padding: 4,
  },
  ratingLabel: {
    fontSize: 18,
    fontWeight: '700',
  },
  commentSection: {
    marginBottom: 24,
  },
  optional: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: -12,
    marginBottom: 12,
  },
  commentInput: {
    backgroundColor: colors.cardElevated,
    borderRadius: 12,
    padding: 16,
    fontSize: 15,
    color: colors.text,
    minHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
  },
  charCount: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 8,
  },
  tagsSection: {
    marginBottom: 24,
  },
  tagsTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textMuted,
    marginBottom: 12,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.cardElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tagActive: {
    backgroundColor: '#3B82F620',
    borderColor: colors.brand,
  },
  tagText: {
    fontSize: 13,
    color: colors.textMuted,
    fontWeight: '500',
  },
  tagTextActive: {
    color: colors.brand,
  },
  footer: {
    padding: 20,
    paddingBottom: 32,
    backgroundColor: colors.backgroundSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.cardElevated,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
});
