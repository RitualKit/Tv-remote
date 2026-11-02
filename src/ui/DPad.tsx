import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';

type Dir = 'up' | 'down' | 'left' | 'right' | 'ok';

const SIZE = 248;
const OK_SIZE = 92;

export function DPad({ onPress }: { onPress: (d: Dir) => void }) {
  const press = (d: Dir) => {
    Haptics.impactAsync(d === 'ok' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress(d);
  };

  const arrow = (d: Exclude<Dir, 'ok'>, icon: keyof typeof Ionicons.glyphMap, pos: object) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={d}
      onPress={() => press(d)}
      style={({ pressed }) => [styles.arrow, pos, pressed && styles.arrowPressed]}
      hitSlop={4}
    >
      <Ionicons name={icon} size={34} color={colors.text} />
    </Pressable>
  );

  return (
    <View style={styles.ring}>
      {arrow('up', 'chevron-up', styles.top)}
      {arrow('down', 'chevron-down', styles.bottom)}
      {arrow('left', 'chevron-back', styles.left)}
      {arrow('right', 'chevron-forward', styles.right)}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="OK"
        onPress={() => press('ok')}
        style={({ pressed }) => [styles.ok, pressed && styles.okPressed]}
      >
        <Text style={styles.okText}>OK</Text>
      </Pressable>
    </View>
  );
}

const ARROW = (SIZE - OK_SIZE) / 2;

const styles = StyleSheet.create({
  ring: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'center',
  },
  arrow: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: ARROW / 2,
  },
  arrowPressed: { backgroundColor: colors.buttonPressed },
  top: { top: 0, left: ARROW, width: OK_SIZE, height: ARROW },
  bottom: { bottom: 0, left: ARROW, width: OK_SIZE, height: ARROW },
  left: { left: 0, top: ARROW, width: ARROW, height: OK_SIZE },
  right: { right: 0, top: ARROW, width: ARROW, height: OK_SIZE },
  ok: {
    position: 'absolute',
    top: ARROW,
    left: ARROW,
    width: OK_SIZE,
    height: OK_SIZE,
    borderRadius: OK_SIZE / 2,
    backgroundColor: colors.button,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  okPressed: { backgroundColor: colors.accent },
  okText: { color: colors.text, fontSize: 20, fontWeight: '700' },
});
