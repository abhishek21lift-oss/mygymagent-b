import { validate } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

describe('CreateProductDto', () => {
  it('accepts a valid product payload', async () => {
    const dto = Object.assign(new CreateProductDto(), {
      sku: 'WHEY-001',
      name: 'Whey Protein',
      unitPrice: 2499,
      costPrice: 1800,
      quantityOnHand: 10,
      reorderLevel: 3,
      isActive: true,
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects negative stock values', async () => {
    const dto = Object.assign(new CreateProductDto(), {
      sku: 'WHEY-001',
      name: 'Whey Protein',
      unitPrice: 2499,
      quantityOnHand: -1,
      reorderLevel: -1,
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['quantityOnHand', 'reorderLevel']),
    );
  });
});
