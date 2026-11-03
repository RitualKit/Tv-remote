import React, { useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { TvApp } from '../tv/apps';
import { colors } from './theme';

const COLUMNS = 3;
const GAP = 14;

interface Props {
  apps: TvApp[];
  onLaunch: (app: TvApp) => void;
  /** Opens the app-button editor (Edit tile, or long-press on any app). */
  onEdit: () => void;
}

/** The Apps page: one big tile per app button, plus an Edit tile at the end. */
export function AppGrid({ apps, onLaunch, onEdit }: Props) {
  const [width, setWidth] = useState(0);
  const size = width > 0 ? Math.floor((width - GAP * (COLUMNS - 1)) / COLUMNS) : 0;
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View onLayout={onLayout} style={styles.grid}>
      {size > 0 &&
        apps.map((app) => (
          <Pressable
            key={app.key}
            accessibilityRole="button"
            accessibilityLabel={`Open ${app.name} on the TV`}
            accessibilityHint="Long-press to edit app buttons"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              onLaunch(app);
            }}
            onLongPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
              onEdit();
            }}
            delayLongPress={600}
            style={({ pressed }) => [
              styles.tile,
              { width: size, height: size, backgroundColor: app.color },
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.initial} numberOfLines={1}>
              {initialOf(app.name)}
            </Text>
            <Text style={styles.name} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
              {app.name}
            </Text>
          </Pressable>
        ))}
      {size > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit app buttons"
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onEdit();
          }}
          style={({ pressed }) => [styles.tile, styles.editTile, { width: size, height: size }, pressed && styles.pressed]}
        >
          <Ionicons name={apps.length ? 'create-outline' : 'add'} size={30} color={colors.text} />
          <Text style={styles.editLabel}>{apps.length ? 'Edit apps' : 'Add apps'}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** First letter or digit of the name, e.g. "Disney+" → "D", "4 Play" → "4". */
function initialOf(name: string): string {
  const m = name.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '•';
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  tile: {
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    gap: 4,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
  initial: { color: '#FFFFFF', fontSize: 34, fontWeight: '800', opacity: 0.95 },
  name: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  editTile: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  editLabel: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
});
