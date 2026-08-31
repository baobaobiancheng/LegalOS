import { HttpException } from '@nestjs/common';

export function crmA1Error(status: number, code: string, error: string): HttpException {
  return new HttpException({ error, code }, status);
}
