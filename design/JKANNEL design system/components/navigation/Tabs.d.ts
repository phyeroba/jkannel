import * as React from 'react';

export interface TabItem {
  id: string;
  label: string;
  /** Optional trailing count, rendered in tabular figures. */
  count?: number;
}

/**
 * Tab strip built on the console's segmented control.
 * @startingPoint section="Navigation" subtitle="Segmented tab strip with counts" viewport="700x120"
 */
export interface TabsProps {
  tabs: Array<TabItem | string>;
  value: string;
  onChange: (id: string) => void;
  style?: React.CSSProperties;
}
export declare function Tabs(props: TabsProps): JSX.Element;
