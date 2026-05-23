import React, { useEffect, useRef } from 'react';
import {View, StyleSheet, Animated, Dimensions, Platform} from 'react-native';

const { width } = Dimensions.get('window');

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: any;
}

export function Skeleton({ width: w = '100%', height = 20, borderRadius = 8, style }: SkeletonProps) {
  const animatedValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(animatedValue, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(animatedValue, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [animatedValue]);

  const opacity = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <Animated.View
      style={[
        styles.skeleton,
        { width: w, height, borderRadius, opacity },
        style,
      ]}
    />
  );
}

// Card Skeleton for service/booking cards
export function CardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Skeleton width={48} height={48} borderRadius={12} />
        <View style={styles.cardHeaderText}>
          <Skeleton width="60%" height={18} />
          <Skeleton width="40%" height={14} style={{ marginTop: 8 }} />
        </View>
      </View>
      <View style={styles.cardBody}>
        <Skeleton width="100%" height={14} />
        <Skeleton width="70%" height={14} style={{ marginTop: 8 }} />
      </View>
      <View style={styles.cardFooter}>
        <Skeleton width={80} height={32} borderRadius={8} />
        <Skeleton width={60} height={20} />
      </View>
    </View>
  );
}

// List of card skeletons
export function CardListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </View>
  );
}

// Profile skeleton
export function ProfileSkeleton() {
  return (
    <View style={styles.profile}>
      <Skeleton width={80} height={80} borderRadius={40} />
      <Skeleton width={150} height={20} style={{ marginTop: 16 }} />
      <Skeleton width={200} height={14} style={{ marginTop: 8 }} />
    </View>
  );
}

// Stats skeleton
export function StatsSkeleton() {
  return (
    <View style={styles.stats}>
      {[1, 2, 3, 4].map((i) => (
        <View key={i} style={styles.statItem}>
          <Skeleton width={44} height={44} borderRadius={12} />
          <Skeleton width={50} height={24} style={{ marginTop: 12 }} />
          <Skeleton width={60} height={14} style={{ marginTop: 4 }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardHeaderText: {
    flex: 1,
    marginLeft: 12,
  },
  cardBody: {
    marginTop: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
  },
  list: {
    padding: 16,
  },
  profile: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    padding: 16,
  },
  statItem: {
    width: (width - 48) / 2,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
});
