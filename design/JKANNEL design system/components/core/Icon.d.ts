import * as React from 'react';

export declare const ICON_NAMES: string[];
export declare const ICONS: Record<string, string>;

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  /** Glyph name from ICON_NAMES; unknown names fall back to "cog". */
  name: string;
  /** Square px size. Chrome uses 18; metric tiles 20; login lockup 27. */
  size?: number;
}

export declare function Icon(props: IconProps): JSX.Element;
