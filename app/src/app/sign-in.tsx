import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { register, signIn } from '@/auth/auth';
import { Button, Field, FormError } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

// One screen for both, switched by the link at the bottom. On success the
// session status changes and the root layout replaces this screen with the
// tabs; nothing here navigates.
export default function SignInScreen() {
  const t = useTheme();
  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const isRegister = mode === 'register';

  const submit = useMutation({
    mutationFn: () =>
      isRegister
        ? register({ email, password, displayName })
        : signIn(email, password),
  });

  const canSubmit =
    email.trim() !== '' &&
    password !== '' &&
    (!isRegister || displayName.trim() !== '');

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: t.background }]}>
      <ScrollView
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={[styles.title, { color: t.text }]}>
          {isRegister ? 'Create account' : 'Sign in'}
        </Text>
        <Text style={[styles.subtitle, { color: t.muted }]}>
          Invite people and answer their invitations.
        </Text>
        {isRegister ? (
          <Field
            label="Your name"
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={80}
            textContentType="name"
            autoComplete="name"
          />
        ) : null}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType={isRegister ? 'emailAddress' : 'username'}
          autoComplete="email"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType={isRegister ? 'newPassword' : 'password'}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          hint={isRegister ? 'At least 10 characters.' : undefined}
          onSubmitEditing={() => canSubmit && submit.mutate()}
        />
        <FormError error={submit.error} />
        <Button
          title={isRegister ? 'Create account' : 'Sign in'}
          onPress={() => submit.mutate()}
          loading={submit.isPending}
          disabled={!canSubmit}
        />
        <Pressable
          accessibilityRole="button"
          style={styles.switch}
          onPress={() => {
            setMode(isRegister ? 'signIn' : 'register');
            submit.reset();
          }}
        >
          <Text style={[styles.switchText, { color: t.accent }]}>
            {isRegister ? 'Have an account? Sign in' : 'New here? Create an account'}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  form: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
  title: { fontSize: 32, fontWeight: '700' },
  subtitle: { fontSize: 17, marginBottom: space.sm },
  switch: { alignSelf: 'center', padding: space.sm },
  switchText: { fontSize: 15, fontWeight: '500' },
});
