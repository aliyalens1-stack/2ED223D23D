import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import {Animated, Text, StyleSheet, Dimensions, TouchableOpacity, View, Platform} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const { width } = Dimensions.get('window');

interface ToastOptions {
  type?: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
  action?: {
    label: string;
    onPress: () => void;
  };
}

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => void;
  hideToast: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

const TOAST_CONFIG = {
  success: { icon: 'checkmark-circle', bg: colors.success, iconColor: colors.text },
  error: { icon: 'close-circle', bg: colors.brand, iconColor: colors.text },
  info: { icon: 'information-circle', bg: colors.brand, iconColor: colors.text },
  warning: { icon: 'warning', bg: colors.warning, iconColor: colors.text },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [options, setOptions] = useState<ToastOptions>({});
  const translateY = useRef(new Animated.Value(-100)).current;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideToast = useCallback(() => {
    Animated.timing(translateY, {
      toValue: -100,
      duration: 300,
      useNativeDriver: Platform.OS !== 'web',
    }).start(() => {
      setVisible(false);
    });
  }, [translateY]);

  const showToast = useCallback((msg: string, opts: ToastOptions = {}) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    setMessage(msg);
    setOptions(opts);
    setVisible(true);

    Animated.timing(translateY, {
      toValue: 0,
      duration: 300,
      useNativeDriver: Platform.OS !== 'web',
    }).start();

    const duration = opts.duration || 3000;
    timeoutRef.current = setTimeout(hideToast, duration);
  }, [translateY, hideToast]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const config = TOAST_CONFIG[options.type || 'info'];

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      {visible && (
        <Animated.View
          style={[
            styles.container,
            { backgroundColor: config.bg, transform: [{ translateY }] },
          ]}
        >
          <View style={styles.content}>
            <Ionicons name={config.icon as any} size={22} color={config.iconColor} />
            <Text style={styles.message} numberOfLines={2}>{message}</Text>
            {options.action && (
              <TouchableOpacity onPress={options.action.onPress} style={styles.actionBtn}>
                <Text style={styles.actionText}>{options.action.label}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={hideToast} style={styles.closeBtn}>
              <Ionicons name="close" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 9999,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  message: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    lineHeight: 20,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 6,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  closeBtn: {
    padding: 4,
  },
});
