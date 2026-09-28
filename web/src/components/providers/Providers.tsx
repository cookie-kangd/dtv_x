"use client";

import React from "react";

import { ThemeProvider } from "@/state/theme/ThemeProvider";
import { FollowProvider } from "@/state/follow/FollowProvider";
import { CustomCategoriesProvider } from "@/state/customCategories/CustomCategoriesProvider";
import { PlayerUiProvider } from "@/state/playerUi/PlayerUiProvider";
import { SettingsProvider } from "@/state/settings/SettingsProvider";
import { HighRefreshRateEffect } from "@/hooks/useHighRefreshRate";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <ThemeProvider>
        <FollowProvider>
          <PlayerUiProvider>
            <CustomCategoriesProvider>
              <HighRefreshRateEffect />
              {children}
            </CustomCategoriesProvider>
          </PlayerUiProvider>
        </FollowProvider>
      </ThemeProvider>
    </SettingsProvider>
  );
}
