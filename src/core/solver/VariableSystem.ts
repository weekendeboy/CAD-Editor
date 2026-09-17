import { CADEntity2D } from '../../types/cad';

export interface VariableDescriptor {
  entityId: string;
  propPath: string; // e.g., 'start.x', 'center.y', 'radius'
  index: number;
}

export class VariableSystem {
  private descriptors: VariableDescriptor[] = [];
  private indexMap: Map<string, number> = new Map();

  constructor() {}

  private getMapKey(entityId: string, propPath: string): string {
    return `${entityId}::${propPath}`;
  }

  /**
   * 將圖元陣列轉換為一維數值向量
   */
  public extractVariables(entities: CADEntity2D[]): number[] {
    this.descriptors = [];
    this.indexMap.clear();
    const x: number[] = [];
    let currentIndex = 0;

    const addVar = (entityId: string, propPath: string, value: number) => {
      this.descriptors.push({ entityId, propPath, index: currentIndex });
      this.indexMap.set(this.getMapKey(entityId, propPath), currentIndex);
      x.push(value);
      currentIndex++;
    };

    for (const ent of entities) {
      if (ent.type === 'line') {
        addVar(ent.id, 'start.x', ent.start.x);
        addVar(ent.id, 'start.y', ent.start.y);
        addVar(ent.id, 'end.x', ent.end.x);
        addVar(ent.id, 'end.y', ent.end.y);
      } else if (ent.type === 'circle') {
        addVar(ent.id, 'center.x', ent.center.x);
        addVar(ent.id, 'center.y', ent.center.y);
        addVar(ent.id, 'radius', ent.radius);
      } else if (ent.type === 'arc') {
        addVar(ent.id, 'center.x', ent.center.x);
        addVar(ent.id, 'center.y', ent.center.y);
        addVar(ent.id, 'radius', ent.radius);
        addVar(ent.id, 'startAngle', ent.startAngle);
        addVar(ent.id, 'endAngle', ent.endAngle);
      } else if (ent.type === 'polyline') {
        ent.points.forEach((pt, i) => {
          addVar(ent.id, `points[${i}].x`, pt.x);
          addVar(ent.id, `points[${i}].y`, pt.y);
        });
      } else if (ent.type === 'insert') {
        addVar(ent.id, 'position.x', ent.position.x);
        addVar(ent.id, 'position.y', ent.position.y);
        addVar(ent.id, 'scale.x', ent.scale.x);
        addVar(ent.id, 'scale.y', ent.scale.y);
        addVar(ent.id, 'rotation', ent.rotation);
      }
    }

    return x;
  }

  /**
   * 根據索引映射取回變數值索引
   */
  public getVariableIndex(entityId: string, propPath: string): number {
    const key = this.getMapKey(entityId, propPath);
    const idx = this.indexMap.get(key);
    if (idx === undefined) {
      throw new Error(`Variable not found for ${key}`);
    }
    return idx;
  }

  /**
   * 輔助函數：取得特定圖元特定點的 x, y 變數索引
   */
  public getPointVariableIndices(entity: CADEntity2D, ptIndex?: number): [number, number] {
    if (entity.type === 'line') {
      if (ptIndex === 0 || ptIndex === undefined) {
        return [this.getVariableIndex(entity.id, 'start.x'), this.getVariableIndex(entity.id, 'start.y')];
      } else if (ptIndex === 1) {
        return [this.getVariableIndex(entity.id, 'end.x'), this.getVariableIndex(entity.id, 'end.y')];
      }
    } else if (entity.type === 'circle' || entity.type === 'arc') {
      if (ptIndex === 0 || ptIndex === undefined) {
        return [this.getVariableIndex(entity.id, 'center.x'), this.getVariableIndex(entity.id, 'center.y')];
      }
    } else if (entity.type === 'polyline') {
      if (ptIndex !== undefined) {
        return [this.getVariableIndex(entity.id, `points[${ptIndex}].x`), this.getVariableIndex(entity.id, `points[${ptIndex}].y`)];
      }
    }
    throw new Error(`Unsupported entity type ${entity.type} or ptIndex ${ptIndex} for point variable lookup`);
  }

  /**
   * 取得某圖元的所有變數索引（用於完全固定圖元等場景）
   */
  public getAllVariableIndices(entityId: string): number[] {
    return this.descriptors.filter(d => d.entityId === entityId).map(d => d.index);
  }

  /**
   * 將數值向量寫回圖元實例（不修改原始物件，回傳新陣列）
   */
  public applyVariables(x: number[], entities: CADEntity2D[]): CADEntity2D[] {
    const newEntities = JSON.parse(JSON.stringify(entities)) as CADEntity2D[];
    
    const entMap = new Map<string, CADEntity2D>();
    for (const ent of newEntities) {
      entMap.set(ent.id, ent);
    }

    for (const desc of this.descriptors) {
      const ent = entMap.get(desc.entityId);
      if (!ent) continue;
      
      const val = x[desc.index];
      
      if (ent.type === 'line') {
        if (desc.propPath === 'start.x') ent.start.x = val;
        else if (desc.propPath === 'start.y') ent.start.y = val;
        else if (desc.propPath === 'end.x') ent.end.x = val;
        else if (desc.propPath === 'end.y') ent.end.y = val;
      } else if (ent.type === 'circle') {
        if (desc.propPath === 'center.x') ent.center.x = val;
        else if (desc.propPath === 'center.y') ent.center.y = val;
        else if (desc.propPath === 'radius') ent.radius = val;
      } else if (ent.type === 'arc') {
        if (desc.propPath === 'center.x') ent.center.x = val;
        else if (desc.propPath === 'center.y') ent.center.y = val;
        else if (desc.propPath === 'radius') ent.radius = val;
        else if (desc.propPath === 'startAngle') ent.startAngle = val;
        else if (desc.propPath === 'endAngle') ent.endAngle = val;
      } else if (ent.type === 'polyline') {
        const match = desc.propPath.match(/points\[(\d+)\]\.(x|y)/);
        if (match) {
          const idx = parseInt(match[1], 10);
          const axis = match[2] as 'x' | 'y';
          if (ent.points[idx]) {
            ent.points[idx][axis] = val;
          }
        }
      } else if (ent.type === 'insert') {
        if (desc.propPath === 'position.x') ent.position.x = val;
        else if (desc.propPath === 'position.y') ent.position.y = val;
        else if (desc.propPath === 'scale.x') ent.scale.x = val;
        else if (desc.propPath === 'scale.y') ent.scale.y = val;
        else if (desc.propPath === 'rotation') ent.rotation = val;
      }
    }

    return newEntities;
  }
}
