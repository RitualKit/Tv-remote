import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  APP_CATALOG,
  TvApp,
  addApp,
  buttonForInstalledApp,
  defaultApps,
  hasApp,
  isValidAppId,
  makeCustomApp,
  moveApp,
  removeApp,
} from '../tv/apps';
import { AppStatus } from '../tv/rest';
import type { TvAppsState } from '../useRemote';
import { RemoteButton } from './RemoteButton';
import { colors } from './theme';

type CheckState = AppStatus | 'checking';

interface Props {
  visible: boolean;
  apps: TvApp[];
  /** Empty when no TV is set up yet: checks are skipped. */
  tvIp: string;
  onClose: () => void;
  onChange: (apps: TvApp[]) => void;
  onCheck: (app: TvApp) => Promise<{ status: AppStatus; app: TvApp }>;
  /** The TV's own installed-app list, and a way to request it. */
  tvApps: TvAppsState;
  onLoadTvApps: () => void;
}

export function AppsModal({ visible, apps, tvIp, onClose, onChange, onCheck, tvApps, onLoadTvApps }: Props) {
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [customId, setCustomId] = useState('');

  const check = async (app: TvApp) => {
    if (!tvIp) return;
    setChecks((c) => ({ ...c, [app.key]: 'checking' }));
    const { status } = await onCheck(app);
    setChecks((c) => ({ ...c, [app.key]: status }));
  };

  // On open: check every current button against the TV (a few at a time).
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    let cancelled = false;
    (async () => {
      const queue = [...apps];
      const worker = async () => {
        while (queue.length && !cancelled) await check(queue.shift()!);
      };
      await Promise.all([worker(), worker(), worker()]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tvIp]);

  const add = (app: TvApp) => {
    Haptics.selectionAsync().catch(() => {});
    onChange(addApp(apps, app));
    check(app);
  };

  const idOk = isValidAppId(customId);
  const customApp = idOk ? makeCustomApp(customName, customId) : null;
  const customDuplicate = customApp ? hasApp(apps, customApp) : false;
  const addCustom = () => {
    if (!customApp || customDuplicate) return;
    add(customApp);
    setCustomName('');
    setCustomId('');
  };

  const catalogMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return APP_CATALOG.filter((a) => !hasApp(apps, a) && (!q || a.name.toLowerCase().includes(q)));
  }, [apps, query]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>App buttons</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.link}>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Your buttons</Text>
            {!tvIp && <Text style={styles.hint}>Set up the TV first to check which apps it has.</Text>}
            {apps.length === 0 && <Text style={styles.hint}>No app buttons. Add some below.</Text>}
            {apps.map((app, i) => (
              <View key={app.key} style={styles.row}>
                <View style={[styles.swatch, { backgroundColor: app.color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {app.name}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {app.ids[0]}
                    {app.ids.length > 1 ? `  (+${app.ids.length - 1} alt)` : ''}
                  </Text>
                </View>
                <StatusBadge state={checks[app.key]} onRetry={() => check(app)} />
                <IconBtn name="chevron-up" label={`Move ${app.name} up`} disabled={i === 0} onPress={() => onChange(moveApp(apps, i, -1))} />
                <IconBtn
                  name="chevron-down"
                  label={`Move ${app.name} down`}
                  disabled={i === apps.length - 1}
                  onPress={() => onChange(moveApp(apps, i, 1))}
                />
                <IconBtn name="close" label={`Remove ${app.name}`} danger onPress={() => onChange(removeApp(apps, app.key))} />
              </View>
            ))}

            <Text style={styles.label}>On your TV</Text>
            {tvApps.phase !== 'ready' && (
              <RemoteButton
                label={tvApps.phase === 'loading' ? 'Asking the TV…' : 'Load apps from TV'}
                onPress={tvApps.phase === 'loading' || !tvIp ? () => {} : onLoadTvApps}
                color={tvIp ? undefined : colors.surface}
              />
            )}
            {tvApps.phase === 'offline' && (
              <Text style={styles.hint}>Not connected to the TV yet. Wait for "Connected" on the remote, then try again.</Text>
            )}
            {tvApps.phase === 'unsupported' && (
              <Text style={styles.hint}>
                Your TV didn't send its app list (not every model does). Pick from the list below, or add by ID.
              </Text>
            )}
            {tvApps.phase === 'ready' &&
              (() => {
                const notAdded = tvApps.apps.map(buttonForInstalledApp).filter((b) => !hasApp(apps, b));
                return notAdded.length === 0 ? (
                  <Text style={styles.hint}>Every app the TV reported is already a button.</Text>
                ) : (
                  notAdded.map((b) => (
                    <Pressable
                      key={b.key}
                      onPress={() => add(b)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${b.name}`}
                      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    >
                      <View style={[styles.swatch, { backgroundColor: b.color }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name} numberOfLines={1}>
                          {b.name}
                        </Text>
                        <Text style={styles.meta} numberOfLines={1}>
                          {b.ids[0]}
                        </Text>
                      </View>
                      <Ionicons name="add-circle" size={26} color={colors.accent} />
                    </Pressable>
                  ))
                );
              })()}

            <Text style={styles.label}>Add any app</Text>
            <Text style={styles.hint}>
              {'For an app that is not listed. You need its Samsung app ID, e.g. from "Load apps from TV" above or ' +
                'on your PC with: npm run probe -- <tv-ip> --apps'}
            </Text>
            <TextInput
              value={customName}
              onChangeText={setCustomName}
              placeholder="Button name (e.g. Crunchyroll)"
              placeholderTextColor={colors.textDim}
              style={styles.input}
            />
            <TextInput
              value={customId}
              onChangeText={setCustomId}
              placeholder="App ID (e.g. 3201807016597)"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            {customId.length > 0 && !idOk && <Text style={[styles.hint, styles.bad]}>That doesn't look like a Samsung app ID.</Text>}
            {customDuplicate && <Text style={[styles.hint, styles.bad]}>That app is already a button.</Text>}
            <RemoteButton
              label="Add app"
              onPress={addCustom}
              color={customApp && !customDuplicate ? colors.accent : colors.button}
              style={{ marginTop: 4 }}
            />

            <Text style={styles.label}>Add from list</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search apps"
              placeholderTextColor={colors.textDim}
              autoCorrect={false}
              style={styles.input}
            />
            {catalogMatches.map((app) => (
              <Pressable
                key={app.key}
                onPress={() => add(app)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${app.name}`}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={[styles.swatch, { backgroundColor: app.color }]} />
                <Text style={[styles.name, { flex: 1 }]}>{app.name}</Text>
                <Ionicons name="add-circle" size={26} color={colors.accent} />
              </Pressable>
            ))}
            {catalogMatches.length === 0 && (
              <Text style={styles.hint}>{query ? 'No match. Add it by ID above.' : 'Every listed app is already a button.'}</Text>
            )}

            <RemoteButton label="Reset to default buttons" onPress={() => onChange(defaultApps())} style={{ marginTop: 24 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function StatusBadge({ state, onRetry }: { state?: CheckState; onRetry: () => void }) {
  if (!state) return null;
  if (state === 'checking') return <Text style={styles.badgeDim}>…</Text>;
  if (state === 'installed') return <Text style={[styles.badge, { color: colors.ok, borderColor: colors.ok }]}>On TV</Text>;
  if (state === 'missing')
    return (
      <Pressable onPress={onRetry} hitSlop={8}>
        <Text style={[styles.badge, { color: colors.warn, borderColor: colors.warn }]}>Not found</Text>
      </Pressable>
    );
  return (
    <Pressable onPress={onRetry} hitSlop={8} accessibilityLabel="Couldn't check, tap to retry">
      <Text style={styles.badgeDim}>?</Text>
    </Pressable>
  );
}

function IconBtn(props: { name: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable
      onPress={props.disabled ? undefined : props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      hitSlop={4}
      style={({ pressed }) => [styles.iconBtn, pressed && !props.disabled && styles.rowPressed]}
    >
      <Ionicons
        name={props.name}
        size={20}
        color={props.disabled ? colors.border : props.danger ? colors.bad : colors.text}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  link: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  body: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 16 },
  hint: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  bad: { color: colors.bad },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 12,
    paddingRight: 6,
    minHeight: 56,
  },
  rowPressed: { backgroundColor: colors.buttonPressed },
  swatch: { width: 14, height: 14, borderRadius: 4 },
  name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  iconBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  badgeDim: { color: colors.textDim, fontSize: 14, fontWeight: '700', paddingHorizontal: 6 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
