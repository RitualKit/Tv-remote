import React from 'react';
import { StyleSheet, View } from 'react-native';
import { RemoteButton } from './RemoteButton';
import { APPS, TvApp } from '../tv/keys';

export function AppRow({ onLaunch }: { onLaunch: (app: TvApp) => void }) {
  return (
    <View style={styles.row}>
      {APPS.map((app) => (
        <RemoteButton key={app.name} label={app.name} color={app.color} onPress={() => onLaunch(app)} style={styles.app} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  app: { flex: 1, paddingHorizontal: 4 },
});
