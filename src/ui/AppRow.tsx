import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RemoteButton } from './RemoteButton';
import { colors } from './theme';
import { TvApp } from '../tv/apps';

interface Props {
  apps: TvApp[];
  onLaunch: (app: TvApp) => void;
  /** Opens the app-button editor (also on long-press of any app). */
  onEdit: () => void;
}

export function AppRow({ apps, onLaunch, onEdit }: Props) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {apps.map((app) => (
        <RemoteButton
          key={app.key}
          label={app.name}
          color={app.color}
          onPress={() => onLaunch(app)}
          onLongPress={onEdit}
          accessibilityLabel={`Open ${app.name}. Long-press to edit app buttons`}
          style={styles.app}
        />
      ))}
      <RemoteButton
        icon={<Ionicons name={apps.length ? 'create-outline' : 'add'} size={22} color={colors.text} />}
        label={apps.length ? 'Edit' : 'Add apps'}
        onPress={onEdit}
        accessibilityLabel="Edit app buttons"
        style={styles.edit}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingRight: 4 },
  app: { minWidth: 96, paddingHorizontal: 14 },
  edit: { minWidth: 72, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
});
