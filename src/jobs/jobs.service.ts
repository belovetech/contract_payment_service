import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { CreateJobDto } from './dto/create-job.dto';
import { PrismaService } from '../prismaClient/prisma.service';
import { contracts_status } from '@prisma/client';
import { ProfilesService } from 'src/profiles/profiles.service';
import { Job } from './entities/job.entity';

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private profileService: ProfilesService,
  ) {}

  async create(createJobDto: CreateJobDto) {
    const isValidContract = await this.prisma.contracts.findUnique({
      where: {
        id: createJobDto.contract_id,
      },
    });

    if (!isValidContract) {
      throw new NotFoundException('Contract does not exist');
    }

    return this.prisma.jobs.create({
      data: {
        ...createJobDto,
        is_paid: false,
      },
    });
  }

  async getUnpaidJobs(profile_id: number) {
    return this.prisma.jobs.findMany({
      where: {
        contract: {
          OR: [
            {
              client_id: profile_id,
            },
            {
              contractor_id: profile_id,
            },
          ],
          status: contracts_status.in_progress,
        },
        is_paid: false,
      },
    });
  }

  async payForJob(job_id: number, client_id: number) {
    //TODO! Implement idempotency
    /**
     * Check if job exists
     * check the client's balance
     * create a transaction
     * decrement the client's balance
     * increment the contractor's balance
     * mark the job as paid
     * commit the transaction
     *
     * Question1:
     *  do we check balance inside or outside the transaction?
     * Answer1:
     *  Inside the transaction
     *
     * Question2:
     *  What happesn if check the client's balance inside the transaction without locking the row?
     * Answer2:
     *  The client's balance can change between the time we check the balance and the time we decrement the balance
     *
     * Solution:
     *  Select the client's balance for a write operation with a lock
     *  check if the client has enough balance
     *     if not, rollback the transaction
     *     if yes, decrement the client's balance
     *     increment the contractor's balance
     *     mark the job as paid
     *     commit the transaction
     *
     *
     */
    const job = await this.prisma.jobs.findUnique({
      where: {
        id: job_id,
      },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const contract = await this.prisma.contracts.findUnique({
      where: {
        id: job.contract_id,
      },
    });

    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    if (contract.client_id !== client_id) {
      throw new NotFoundException('You are not authorized to pay for this job');
    }

    if (job.is_paid) {
      throw new BadRequestException('Job has already been paid for');
    }

    return this.prisma.$transaction(async (trx) => {
      const client = await trx.profiles.findUnique({
        where: {
          id: client_id,
        },
        select: {
          balance: true,
        },
      });

      if (job.price > client.balance) {
        throw new PreconditionFailedException('Insufficient balance');
      }

      const updatedClient = await trx.profiles.update({
        where: {
          id: client_id,
        },
        data: {
          balance: {
            decrement: job.price,
          },
        },
      });

      await trx.profiles.update({
        where: {
          id: contract.contractor_id,
        },
        data: {
          balance: {
            increment: job.price,
          },
        },
      });

      await trx.jobs.update({
        where: {
          id: job_id,
        },
        data: {
          is_paid: true,
          paid_date: new Date(),
        },
      });

      return { updatedClient };
    });
  }
}
