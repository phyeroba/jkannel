import * as React from 'react';

export interface MiniChartSeries {
  name: string;
  values: number[];
}

/**
 * Dependency-free line chart (ported from MiniChart.vue).
 * @startingPoint section="Data" subtitle="Line series and CSS bar volume chart" viewport="700x300"
 */
export interface MiniChartProps {
  series: MiniChartSeries[];
  height?: number;
  width?: number;
  /** X-axis tick labels, one per point. */
  labels?: string[];
  showLegend?: boolean;
}
export declare function MiniChart(props: MiniChartProps): JSX.Element;

export interface BarChartProps {
  values: number[];
  titleFor?: (value: number, index: number) => string;
}
/** The dashboard's CSS gradient bar chart. */
export declare function BarChart(props: BarChartProps): JSX.Element;
