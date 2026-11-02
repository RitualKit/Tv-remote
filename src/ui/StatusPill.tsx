import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ConnSnapshot } from '../tv/SamsungRemote';
import { ConnectionMode } from '../tv/protocol';
import { colors } from './theme';

const LABELS: Record<ConnSnapshot['status'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  awaitingAllow: 'Waiting for TV…',
  connected: 'Connected',
  unauthorized: 'Refused by TV',
  error: 'Disconnected',
};

function dotColor(s: ConnSnapshot['status']) {
  if (s === 'connected') return colors.ok;
  if (s === 'connecting' || s === 'awaitingAllow') return colors.warn;
  if (s === 'idle') return colors.textDim;
  return colors.bad;
}

export function StatusPill({ conn, mode, onPress }: { conn: ConnSnapshot; mode: ConnectionMode; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.pill} accessibilityRole="button" accessibilityHint="Tap to reconnect">
      <View style={[styles.dot, { backgroundColor: dotColor(conn.status) }]} />
      <Text style={styles.text}>
        {LABELS[conn.status]}
        {conn.status === 'connected' ? (mode === 'relay' ? ' · relay' : ' · direct') : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
