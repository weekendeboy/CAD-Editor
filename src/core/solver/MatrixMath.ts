export class MatrixMath {
  public static copy(A: number[][]): number[][] {
    return A.map(row => [...row]);
  }

  public static transpose(A: number[][]): number[][] {
    if (A.length === 0) return [];
    const rows = A.length;
    const cols = A[0].length;
    const res = Array(cols).fill(0).map(() => Array(rows).fill(0));
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        res[j][i] = A[i][j];
      }
    }
    return res;
  }

  public static multiply(A: number[][], B: number[][]): number[][] {
    if (A.length === 0 || B.length === 0) return [];
    const rowsA = A.length;
    const colsA = A[0].length;
    const colsB = B[0].length;
    const res = Array(rowsA).fill(0).map(() => Array(colsB).fill(0));
    for (let i = 0; i < rowsA; i++) {
      for (let j = 0; j < colsB; j++) {
        let sum = 0;
        for (let k = 0; k < colsA; k++) {
          sum += A[i][k] * B[k][j];
        }
        res[i][j] = sum;
      }
    }
    return res;
  }

  public static multiplyVector(A: number[][], v: number[]): number[] {
    if (A.length === 0) return [];
    const rows = A.length;
    const cols = A[0].length;
    const res = Array(rows).fill(0);
    for (let i = 0; i < rows; i++) {
      let sum = 0;
      for (let j = 0; j < cols; j++) {
        sum += A[i][j] * v[j];
      }
      res[i] = sum;
    }
    return res;
  }

  /**
   * Gaussian elimination with partial pivoting to solve Ax = b
   */
  public static solve(A: number[][], b: number[]): number[] {
    const n = b.length;
    if (n === 0) return [];
    
    // Create augmented matrix
    const M = A.map((row, i) => [...row, b[i]]);

    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxEl = Math.abs(M[i][i]);
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(M[k][i]) > maxEl) {
          maxEl = Math.abs(M[k][i]);
          maxRow = k;
        }
      }

      // Swap rows
      if (maxRow !== i) {
        const temp = M[i];
        M[i] = M[maxRow];
        M[maxRow] = temp;
      }

      // If matrix is singular, add a small regularization term to the diagonal
      if (Math.abs(M[i][i]) < 1e-12) {
        M[i][i] = 1e-12;
      }

      // Eliminate
      for (let k = i + 1; k < n; k++) {
        const c = -M[k][i] / M[i][i];
        for (let j = i; j < n + 1; j++) {
          if (i === j) {
            M[k][j] = 0;
          } else {
            M[k][j] += c * M[i][j];
          }
        }
      }
    }

    // Back substitution
    const x = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = 0;
      for (let j = i + 1; j < n; j++) {
        sum += M[i][j] * x[j];
      }
      x[i] = (M[i][n] - sum) / M[i][i];
    }
    return x;
  }
}
