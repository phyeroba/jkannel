import { Injectable } from '@nestjs/common';

export interface ConfigurationDiffLine {
  line: number;
  kind: 'unchanged' | 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

@Injectable()
export class ConfigurationDiffService {
  compare(before: string, after: string): ConfigurationDiffLine[] {
    const left = before.split('\n');
    const right = after.split('\n');
    const length = Math.max(left.length, right.length);
    const result: ConfigurationDiffLine[] = [];
    for (let index = 0; index < length; index += 1) {
      const oldLine = left[index];
      const newLine = right[index];
      if (oldLine === newLine)
        result.push({ line: index + 1, kind: 'unchanged', before: oldLine, after: newLine });
      else if (oldLine === undefined)
        result.push({ line: index + 1, kind: 'added', after: newLine });
      else if (newLine === undefined)
        result.push({ line: index + 1, kind: 'removed', before: oldLine });
      else result.push({ line: index + 1, kind: 'changed', before: oldLine, after: newLine });
    }
    return result;
  }
}
