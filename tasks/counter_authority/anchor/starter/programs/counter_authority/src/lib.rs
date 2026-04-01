use anchor_lang::prelude::*;

declare_id!("2jM5zF1tN3UiYh6R6PCYJw3fd6kjYH1rcY4h4g3YFmV7");

#[program]
pub mod counter_authority {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        todo!("set authority and reset count");
    }

    pub fn increment(_ctx: Context<Increment>) -> Result<()> {
        todo!("authorize signer and increment count");
    }

    pub fn set_authority(_ctx: Context<SetAuthority>, _new_authority: Pubkey) -> Result<()> {
        todo!("authorize signer and update authority");
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + CounterAccount::INIT_SPACE)]
    pub counter: Account<'info, CounterAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut)]
    pub counter: Account<'info, CounterAccount>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(mut)]
    pub counter: Account<'info, CounterAccount>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct CounterAccount {
    pub authority: Pubkey,
    pub count: u64,
}

#[error_code]
pub enum CounterError {
    #[msg("Unauthorized signer.")]
    Unauthorized,
    #[msg("Counter overflow.")]
    Overflow,
}
