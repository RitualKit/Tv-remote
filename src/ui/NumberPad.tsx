import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RemoteButton } from './RemoteButton';
import { colors } from './theme';
import { KEYS, digitKey } from '../tv/keys';

export function NumberPad({ onKey }: { onKey: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const rows: { label: string; key: string }[][] = [
    [1, 2, 3].map((d) => ({ label: String(d), key: digitKey(d) })),
    [4, 5, 6].map((d) => ({ label: String(d), key: digitKey(d) })),
    [7, 8, 9].map((d) => ({ label: String(d), key: digitKey(d) })),
    [
      { label: 'CH List', key: KEYS.chList },
      { label: '0', key: digitKey(0) },
      { label: 'Enter', key: KEYS.ok },
    ],
  ];

  return (
    <View>
      <Pressable style={styles.header} onPress={() => setOpen((o) => !o)} accessibilityRole="button">
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={18} color={colors.textDim} />
        <Text style={styles.headerText}>Number pad</Text>
      </Pressable>
      {open && (
        <View style={styles.grid}>
          {rows.map((row, i) => (
            <View key={i} style={styles.row}>
              {row.map((b) => (
                <RemoteButton key={b.label} label={b.label} onPress={() => onKey(b.key)} style={styles.cell} />
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 6 },
  headerText: { color: colors.textDim, fontSize: 15, fontWeight: '600' },
  grid: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  cell: { flex: 1, minHeight: 60 },
});
