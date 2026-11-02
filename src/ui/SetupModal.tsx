import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConnectionMode, DEFAULT_RELAY_PORT } from '../tv/protocol';
import { getDeviceInfo } from '../tv/rest';
import { Settings } from '../storage';
import { RemoteButton } from './RemoteButton';
import { colors } from './theme';

interface Props {
  visible: boolean;
  settings: Settings;
  log: string[];
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => void;
  onForgetPairing: () => void;
  onRequestApps: () => void;
}

export function SetupModal({ visible, settings, log, onClose, onSave, onForgetPairing, onRequestApps }: Props) {
  const [tvIp, setTvIp] = useState(settings.tvIp);
  const [mode, setMode] = useState<ConnectionMode>(settings.mode);
  const [relayHost, setRelayHost] = useState(settings.relayHost);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setTvIp(settings.tvIp);
      setMode(settings.mode);
      setRelayHost(settings.relayHost);
      setTest(null);
    }
  }, [visible, settings.tvIp, settings.mode, settings.relayHost]);

  const runTest = async () => {
    setTest('Testing…');
    try {
      const info = await getDeviceInfo({ tvIp, mode, relayHost });
      setTest(
        `✓ ${info.name ?? 'TV'} ${info.modelName ? `(${info.modelName})` : ''}\n` +
          `Frame: ${info.frameTv ? 'yes' : 'no'} · Token auth: ${info.tokenAuth ? 'yes' : 'no'} · Power: ${info.powerState ?? '?'}` +
          (mode === 'direct' && info.tokenAuth ? '\nThis TV uses token auth → it will likely need Relay mode.' : ''),
      );
    } catch (e) {
      setTest(
        `✗ Not reachable (${(e as Error).message}).\n` +
          (mode === 'relay'
            ? 'Is relay.mjs running, and is the relay address right?'
            : 'Same Wi-Fi? TV on or in Art Mode? iOS: Local Network allowed for Expo Go?'),
      );
    }
  };

  const save = () => {
    onSave({ tvIp: tvIp.trim(), mode, relayHost: relayHost.trim() });
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>TV setup</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.link}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>TV IP address</Text>
            <TextInput
              value={tvIp}
              onChangeText={setTvIp}
              placeholder="192.168.1.50"
              placeholderTextColor={colors.textDim}
              keyboardType="decimal-pad"
              autoCorrect={false}
              style={styles.input}
            />
            <Text style={styles.hint}>TV: Settings → General → Network → Network Status → IP Settings</Text>

            <Text style={styles.label}>Connection</Text>
            <View style={styles.segment}>
              {(['relay', 'direct'] as const).map((m) => (
                <Pressable key={m} onPress={() => setMode(m)} style={[styles.segBtn, mode === m && styles.segOn]}>
                  <Text style={[styles.segText, mode === m && styles.segTextOn]}>
                    {m === 'relay' ? 'Via relay (2022+)' : 'Direct :8001'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {mode === 'relay' && (
              <>
                <Text style={styles.label}>Relay address</Text>
                <TextInput
                  value={relayHost}
                  onChangeText={setRelayHost}
                  placeholder={`192.168.1.20:${DEFAULT_RELAY_PORT}`}
                  placeholderTextColor={colors.textDim}
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.input}
                />
                <Text style={styles.hint}>
                  The computer/Pi running `node relay/relay.mjs`. Port defaults to {DEFAULT_RELAY_PORT}.
                </Text>
              </>
            )}

            <View style={styles.actions}>
              <RemoteButton label="Test" onPress={runTest} style={styles.flex} />
              <RemoteButton label="Save & connect" onPress={save} color={colors.accent} style={styles.flex} />
            </View>
            {test && <Text style={styles.test}>{test}</Text>}

            <Text style={styles.label}>Pairing</Text>
            <Text style={styles.hint}>{settings.token ? 'Paired (token saved).' : 'Not paired yet — TV will ask to Allow.'}</Text>
            <View style={styles.actions}>
              <RemoteButton label="Forget pairing" onPress={onForgetPairing} style={styles.flex} />
              <RemoteButton label="Log installed apps" onPress={onRequestApps} style={styles.flex} />
            </View>

            <Text style={styles.label}>Debug log</Text>
            <View style={styles.logBox}>
              {log.length === 0 ? (
                <Text style={styles.logLine}>(empty)</Text>
              ) : (
                log.map((l, i) => (
                  <Text key={i} style={styles.logLine} selectable>
                    {l}
                  </Text>
                ))
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  link: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  body: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 16 },
  hint: { color: colors.textDim, fontSize: 13 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  segment: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 12, padding: 4, gap: 4 },
  segBtn: { flex: 1, paddingVertical: 12, borderRadius: 9, alignItems: 'center' },
  segOn: { backgroundColor: colors.button },
  segText: { color: colors.textDim, fontWeight: '600' },
  segTextOn: { color: colors.text },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  flex: { flex: 1 },
  test: { color: colors.text, fontSize: 14, marginTop: 8, lineHeight: 20 },
  logBox: { backgroundColor: colors.surface, borderRadius: 12, padding: 12, gap: 2 },
  logLine: { color: colors.textDim, fontSize: 11, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
