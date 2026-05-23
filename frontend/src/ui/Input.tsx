import React, { useState } from 'react';
import {
  View,
  TextInput,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInputProps,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Spacing, BorderRadius, Typography, ComponentSizes } from '../theme';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  containerStyle?: ViewStyle;
}

export function Input({
  label,
  error,
  icon,
  rightIcon,
  onRightIconPress,
  containerStyle,
  secureTextEntry,
  ...props
}: InputProps) {
  const { colors } = useThemeContext();
  const [focused, setFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const isPassword = secureTextEntry !== undefined;
  const actualSecure = isPassword && !showPassword;

  return (
    <View style={[styles.container, containerStyle]}>
      {label && (
        <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      )}
      <View
        style={[
          styles.inputWrapper,
          {
            backgroundColor: colors.inputBg,
            borderColor: error
              ? colors.error
              : focused
              ? colors.inputFocus
              : colors.inputBorder,
          },
        ]}
      >
        {icon && (
          <Ionicons
            name={icon}
            size={20}
            color={colors.textMuted}
            style={styles.leftIcon}
          />
        )}
        <TextInput
          style={[
            styles.input,
            { color: colors.text },
            icon && styles.inputWithIcon,
          ]}
          placeholderTextColor={colors.inputPlaceholder ?? colors.textMuted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          secureTextEntry={actualSecure}
          {...props}
        />
        {isPassword && (
          <TouchableOpacity
            onPress={() => setShowPassword(!showPassword)}
            style={styles.rightIconBtn}
          >
            <Ionicons
              name={showPassword ? 'eye-off' : 'eye'}
              size={20}
              color={colors.textMuted}
            />
          </TouchableOpacity>
        )}
        {rightIcon && !isPassword && (
          <TouchableOpacity
            onPress={onRightIconPress}
            style={styles.rightIconBtn}
            disabled={!onRightIconPress}
          >
            <Ionicons name={rightIcon} size={20} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>
      {error && (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      )}
    </View>
  );
}

interface SearchInputProps extends Omit<InputProps, 'icon' | 'rightIcon'> {
  onClear?: () => void;
}

export function SearchInput({ value, onClear, ...props }: SearchInputProps) {
  return (
    <Input
      icon="search"
      rightIcon={value ? 'close-circle' : undefined}
      onRightIconPress={onClear}
      {...props}
      value={value}
    />
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.base },
  label: {
    fontSize: Typography.size.sm,
    fontWeight: '500',
    marginBottom: Spacing.sm,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ComponentSizes.inputHeight,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
    paddingHorizontal: Spacing.base,
  },
  input: {
    flex: 1,
    fontSize: Typography.size.base,
    height: '100%',
  },
  inputWithIcon: { marginLeft: Spacing.sm },
  leftIcon: { marginRight: Spacing.xs },
  rightIconBtn: { padding: Spacing.xs, marginLeft: Spacing.sm },
  error: { fontSize: Typography.size.xs, marginTop: Spacing.xs },
});
