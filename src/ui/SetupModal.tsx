import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isPrivateIPv4 } from '../tv/protocol';
import { getDeviceInfo } from '../tv/rest';
import { Settings } from '../storage';
import { RemoteButton } from './RemoteButton';
import { colors } from './theme';

interface Props {
  visible: boolean;
  settings: Settings;
  log: string[];
  onClose: () => void;
  onSaveTvIp: (ip: string) => void;
  onForgetPairing: () => void;
  onResetCertificate: () => void;
  onRequestApps: () => void;
}

export function SetupModal({
  visible,
  settings,
  log,
  onClose,
  onSaveTvIp,
  onForgetPairing,
  onResetCertificate,
  onRequestApps,
}: Props) {
  const [tvIp, setTvIp] = useState(settings.tvIp);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setTvIp(settings.tvIp);
      setTest(null);
    }
  }, [visible, settings.tvIp]);

  const validIp = isPrivateIPv4(tvIp);

  const runTest = async () => {
    setTest('Testing…');
    try {
      const info = await getDeviceInfo({ tvIp });
      setTest(
        `✓ ${info.name ?? 'TV'} ${info.modelName ? `(${info.modelName})` : ''}\n` +
          `Frame: ${info.frameTv ? 'yes' : 'no'} · Token auth: ${info.tokenAuth ? 'yes' : 'no'} · Power: ${info.powerState ?? '?'}`,
      );
    } catch (e) {
      setTest(
        `✗ Not reachable (${(e as Error).message}).\n` +
          'Same Wi-Fi? TV on or in Art Mode? Local Network allowed for Frame Remote (iOS Settings → Privacy & Security)?',
      );
    }
  };

  const save = () => {
    onSaveTvIp(tvIp);
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
            <Text style={[styles.hint, tvIp.length > 0 && !validIp && styles.bad]}>
              {tvIp.length > 0 && !validIp
                ? 'Enter a home-network address like 192.168.x.x, 10.x.x.x or 172.16–31.x.x.'
                : 'TV: Settings → General → Network → Network Status → IP Settings'}
            </Text>

            <View style={styles.actions}>
              <RemoteButton label="Test" onPress={runTest} style={styles.flex} />
              <RemoteButton
                label="Save & connect"
                onPress={validIp ? save : () => {}}
                color={validIp ? colors.accent : colors.button}
                style={styles.flex}
              />
            </View>
            {test && <Text style={styles.test}>{test}</Text>}

            <Text style={styles.label}>Pairing</Text>
            <Text style={styles.hint}>{settings.token ? 'Paired (token saved).' : 'Not paired yet — the TV will ask you to Allow.'}</Text>
            <Text style={styles.hint}>
              {settings.certSha256
                ? `TV certificate pinned: ${settings.certSha256.slice(0, 16)}…`
                : 'TV certificate: pinned automatically on first connect.'}
            </Text>
            <View style={styles.actions}>
              <RemoteButton label="Forget pairing" onPress={onForgetPairing} style={styles.flex} />
              <RemoteButton label="Reset TV certificate" onPress={onResetCertificate} style={styles.flex} />
            </View>
            <View style={styles.actions}>
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
  bad: { color: colors.bad },
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
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  flex: { flex: 1 },
  test: { color: colors.text, fontSize: 14, marginTop: 8, lineHeight: 20 },
  logBox: { backgroundColor: colors.surface, borderRadius: 12, padding: 12, gap: 2 },
  logLine: { color: colors.textDim, fontSize: 11, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
