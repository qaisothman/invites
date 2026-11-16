import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PublicUser, User } from './user.entity';
import { UpdateMeDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async get(id: string): Promise<User> {
    const user = await this.users.findOneBy({ id });
    if (!user)
      throw new NotFoundException({
        code: 'user_not_found',
        message: 'User not found',
      });
    return user;
  }

  async updateMe(id: string, dto: UpdateMeDto): Promise<User> {
    await this.users.update({ id }, dto);
    return this.get(id);
  }

  // Exact-email lookup only: inviting needs one person. A signed-in caller
  // can still learn whether one address is a member; a search box would hand
  // over the whole list.
  async lookupByEmail(email: string): Promise<PublicUser> {
    const user = await this.users.findOne({
      where: { email },
      select: { id: true, displayName: true },
    });
    if (!user)
      throw new NotFoundException({
        code: 'user_not_found',
        message: 'No member with that email',
      });
    return { id: user.id, displayName: user.displayName };
  }
}
