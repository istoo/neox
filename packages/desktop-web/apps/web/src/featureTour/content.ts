import type { LucideIcon } from "~/lib/icons";
import { Columns2Icon, GitPullRequestIcon, UsersIcon, WorkflowIcon } from "~/lib/icons";

export interface FeatureTourSlide {
  id: "workspace" | "accounts" | "review" | "hubs";
  titleKey: string;
  descriptionKey: string;
  highlightKeys: readonly string[];
  icon: LucideIcon;
  feature?: string;
}

// Curated from v0.9.2..HEAD. Keep this tour about changes, not the full feature inventory.
export const FEATURE_TOUR_SLIDES: readonly FeatureTourSlide[] = [
  {
    id: "workspace",
    titleKey: "onboarding:tour_workspaceTitle",
    descriptionKey: "onboarding:tour_workspaceDescription",
    highlightKeys: [
      "onboarding:tour_workspaceHighlight1",
      "onboarding:tour_workspaceHighlight2",
      "onboarding:tour_workspaceHighlight3",
    ],
    icon: Columns2Icon,
  },
  {
    id: "accounts",
    titleKey: "onboarding:tour_accountsTitle",
    descriptionKey: "onboarding:tour_accountsDescription",
    highlightKeys: [
      "onboarding:tour_accountsHighlight1",
      "onboarding:tour_accountsHighlight2",
      "onboarding:tour_accountsHighlight3",
    ],
    icon: UsersIcon,
  },
  {
    id: "review",
    titleKey: "onboarding:tour_reviewTitle",
    descriptionKey: "onboarding:tour_reviewDescription",
    highlightKeys: [
      "onboarding:tour_reviewHighlight1",
      "onboarding:tour_reviewHighlight2",
      "onboarding:tour_reviewHighlight3",
    ],
    icon: GitPullRequestIcon,
  },
  {
    id: "hubs",
    titleKey: "onboarding:tour_hubsTitle",
    descriptionKey: "onboarding:tour_hubsDescription",
    highlightKeys: [
      "onboarding:tour_hubsHighlight1",
      "onboarding:tour_hubsHighlight2",
      "onboarding:tour_hubsHighlight3",
    ],
    icon: WorkflowIcon,
    feature: "groups",
  },
];
