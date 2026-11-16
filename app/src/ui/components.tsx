import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api';

import { space, useTheme } from './theme';

// The handful of building blocks every screen uses. Plain StyleSheet:
// layout is static, colours come from the theme at render time.

/** A tab's page: safe area, background, a large title. */
export function Screen({ title, children }: { title?: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: t.background }]}
    >
      {title ? <Text style={[styles.title, { color: t.text }]}>{title}</Text> : null}
      {children}
    </SafeAreaView>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  loading?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  const primary = variant === 'primary';
  const color = primary ? t.onAccent : t.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: t.accent }
          : { borderColor: t.border, borderWidth: StyleSheet.hairlineWidth },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.buttonText, { color }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.muted }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        accessibilityLabel={label}
        {...input}
        style={[
          styles.input,
          { color: t.text, backgroundColor: t.surface, borderColor: t.border },
          input.multiline && styles.multiline,
        ]}
      />
      {hint ? <Text style={[styles.hint, { color: t.muted }]}>{hint}</Text> : null}
    </View>
  );
}

/** Inline error text under a form. Renders nothing when there's no error. */
export function FormError({ error }: { error: unknown }) {
  const t = useTheme();
  if (!error) return null;
  return <Text style={[styles.formError, { color: t.danger }]}>{errorMessage(error)}</Text>;
}

/** Full-area loading, error and empty states for lists and detail screens. */
export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator />
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[styles.centerText, { color: t.text }]}>{errorMessage(error)}</Text>
      <Button title="Try again" variant="secondary" onPress={onRetry} />
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[styles.centerText, { color: t.muted }]}>{text}</Text>
    </View>
  );
}

/** The API's messages are written for people; show them as they are. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // Validation errors list each failed rule in details; show the first.
    if (error.code === 'validation_failed' && Array.isArray(error.details)) {
      const first = String(error.details[0] ?? error.message);
      return first.charAt(0).toUpperCase() + first.slice(1);
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: {
    fontSize: 32,
    fontWeight: '700',
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  button: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 17, fontWeight: '600' },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  input: {
    fontSize: 17,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  hint: { fontSize: 13, lineHeight: 18 },
  formError: { fontSize: 15 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.lg,
  },
  centerText: { fontSize: 17, textAlign: 'center' },
});
