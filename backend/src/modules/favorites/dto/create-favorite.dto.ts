import { IsMongoId } from 'class-validator';

export class CreateFavoriteDto {
  @IsMongoId()
  organizationId: string;
}
