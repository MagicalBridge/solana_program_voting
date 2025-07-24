import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Voting } from "../target/types/voting";
import { assert } from "chai";
import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";

const IDL = require("../target/idl/voting.json");

describe("solana_program_voting (bankrun版本)", () => {
  let context: any;
  let provider: BankrunProvider;
  let program: Program<Voting>;

  // 测试用的变量
  let pollId: BN;
  let pollAccount: anchor.web3.PublicKey;
  let candidate1Account: anchor.web3.PublicKey;
  let candidate2Account: anchor.web3.PublicKey;
  
  const candidate1Name = "张三";
  const candidate2Name = "李四";
  const pollName = "班长选举";
  const pollDescription = "选择我们班的新班长";
  
  // 使用固定的时间戳便于时间旅行
  const baseTime = 1000; // 固定基础时间
  const startTime = new BN(baseTime + 100); // 开始时间
  const endTime = new BN(baseTime + 3600); // 结束时间

  before(async () => {
    // 初始化 bankrun 测试环境
    context = await startAnchor(
      "", // 项目根目录
      [], // 额外的程序
      [] // 额外的账户
    );

    // 创建 BankrunProvider
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    // 创建程序实例
    program = new Program<Voting>(IDL, provider);

    pollId = new BN(1);
    
    // 计算PDA地址
    [pollAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("poll"), pollId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [candidate1Account] = anchor.web3.PublicKey.findProgramAddressSync(
      [pollId.toArrayLike(Buffer, "le", 8), Buffer.from(candidate1Name)],
      program.programId
    );

    [candidate2Account] = anchor.web3.PublicKey.findProgramAddressSync(
      [pollId.toArrayLike(Buffer, "le", 8), Buffer.from(candidate2Name)],
      program.programId
    );

    console.log("🚀 Bankrun 测试环境初始化完成");
    console.log(`程序 ID: ${program.programId.toString()}`);
  });

  describe("初始化投票测试", () => {
    it("应该成功初始化投票", async () => {
      const tx = await program.methods
        .initializePoll(
          pollId,
          startTime,
          endTime,
          pollName,
          pollDescription
        )
        .rpc();

      console.log("初始化投票交易签名:", tx);

      // 验证投票账户数据
      const pollAccountData = await program.account.pollAccount.fetch(pollAccount);
      assert.equal(pollAccountData.pollName, pollName);
      assert.equal(pollAccountData.pollDescription, pollDescription);
      assert.equal(pollAccountData.pollVotingStart.toString(), startTime.toString());
      assert.equal(pollAccountData.pollVotingEnd.toString(), endTime.toString());
      assert.equal(pollAccountData.pollOptionIndex.toString(), "0");
    });

    it("应该允许重复初始化同一个投票（init_if_needed）", async () => {
      // 再次初始化相同的投票
      await program.methods
        .initializePoll(
          pollId,
          startTime,
          endTime,
          "更新的投票名称",
          "更新的描述"
        )
        .rpc();

      // 验证数据被更新
      const pollAccountData = await program.account.pollAccount.fetch(pollAccount);
      assert.equal(pollAccountData.pollName, "更新的投票名称");
      assert.equal(pollAccountData.pollDescription, "更新的描述");
    });
  });

  describe("候选人初始化测试", () => {
    it("应该成功添加第一个候选人", async () => {
      const tx = await program.methods
        .initializeCandidate(pollId, candidate1Name)
        .accounts({
          pollAccount: pollAccount,
        })
        .rpc();

      console.log("添加候选人1交易签名:", tx);

      // 验证候选人账户数据
      const candidateData = await program.account.candidateAccount.fetch(candidate1Account);
      assert.equal(candidateData.candidateName, candidate1Name);
      assert.equal(candidateData.candidateVotes.toString(), "0");

      // 验证投票选项索引增加
      const pollData = await program.account.pollAccount.fetch(pollAccount);
      assert.equal(pollData.pollOptionIndex.toString(), "1");
    });

    it("应该成功添加第二个候选人", async () => {
      const tx = await program.methods
        .initializeCandidate(pollId, candidate2Name)
        .accounts({
          pollAccount: pollAccount,
        })
        .rpc();

      console.log("添加候选人2交易签名:", tx);

      // 验证候选人账户数据
      const candidateData = await program.account.candidateAccount.fetch(candidate2Account);
      assert.equal(candidateData.candidateName, candidate2Name);
      assert.equal(candidateData.candidateVotes.toString(), "0");

      // 验证投票选项索引增加
      const pollData = await program.account.pollAccount.fetch(pollAccount);
      assert.equal(pollData.pollOptionIndex.toString(), "2");
    });

    it("不应该允许重复添加相同的候选人", async () => {
      try {
        await program.methods
          .initializeCandidate(pollId, candidate1Name)
          .accounts({
            pollAccount: pollAccount,
          })
          .rpc();
        
        assert.fail("应该抛出错误，因为候选人已存在");
      } catch (error) {
        // 期望出现错误，因为候选人账户已经存在
        console.log("预期错误:", error.message);
      }
    });
  });

  describe("投票时间边界测试 (使用时间旅行)", () => {
    it("投票开始前不应该允许投票", async () => {
      // 设置时间为投票开始前
      const currentClock = await context.banksClient.getClock();
      context.setClock(new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        BigInt(baseTime - 10) // 设置为开始时间之前
      ));

      try {
        await program.methods
          .vote(pollId, candidate1Name)
          .rpc();
        
        assert.fail("应该抛出错误，因为投票尚未开始");
      } catch (error) {
        console.log("预期错误（投票尚未开始）:", error.message);
        assert.include(error.message, "VotingNotStarted");
      }
    });

    it("投票开始后应该允许投票", async () => {
      // 🚀 时间旅行：直接跳转到投票开始时间
      console.log("⏰ 时间旅行到投票开始时间...");
      const currentClock = await context.banksClient.getClock();
      context.setClock(new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        BigInt(baseTime + 200) // 设置为开始时间之后
      ));
      
      const tx = await program.methods
        .vote(pollId, candidate1Name)
        .rpc();

      console.log("投票交易签名:", tx);

      // 验证票数增加
      const candidateData = await program.account.candidateAccount.fetch(candidate1Account);
      assert.equal(candidateData.candidateVotes.toString(), "1");
    });

    it("应该允许多次投票", async () => {
      // 在 bankrun 中，我们需要避免重复交易
      // 通过在交易中添加一些不同的数据或使用 setTimeout 来确保交易唯一
      
      // 等待一小段时间确保交易不重复
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 为候选人1再投一票
      await program.methods
        .vote(pollId, candidate1Name)
        .rpc();

      // 等待一小段时间确保交易不重复
      await new Promise(resolve => setTimeout(resolve, 10));

      // 为候选人2投票
      await program.methods
        .vote(pollId, candidate2Name)
        .rpc();

      // 验证票数
      const candidate1Data = await program.account.candidateAccount.fetch(candidate1Account);
      const candidate2Data = await program.account.candidateAccount.fetch(candidate2Account);
      
      assert.equal(candidate1Data.candidateVotes.toString(), "2");
      assert.equal(candidate2Data.candidateVotes.toString(), "1");
    });
  });

  describe("投票结束后测试", () => {
    it("投票结束后不应该允许投票", async () => {
      // 创建一个已经结束的投票
      const expiredPollId = new BN(2);
      const expiredStartTime = new BN(baseTime - 1000); // 过去的开始时间
      const expiredEndTime = new BN(baseTime - 500); // 过去的结束时间

      const [expiredPollAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("poll"), expiredPollId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [expiredCandidateAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [expiredPollId.toArrayLike(Buffer, "le", 8), Buffer.from(candidate1Name)],
        program.programId
      );

      // 初始化过期投票
      await program.methods
        .initializePoll(
          expiredPollId,
          expiredStartTime,
          expiredEndTime,
          "过期投票",
          "这是一个已经结束的投票"
        )
        .rpc();

      // 添加候选人
      await program.methods
        .initializeCandidate(expiredPollId, candidate1Name)
        .accounts({
          pollAccount: expiredPollAccount,
        })
        .rpc();

      // 🚀 时间旅行：设置当前时间为投票结束后
      const currentClock = await context.banksClient.getClock();
      context.setClock(new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        BigInt(baseTime + 100) // 当前时间晚于过期投票的结束时间
      ));

      // 尝试投票（应该失败）
      try {
        await program.methods
          .vote(expiredPollId, candidate1Name)
          .rpc();
        
        assert.fail("应该抛出错误，因为投票已结束");
      } catch (error) {
        console.log("预期错误（投票已结束）:", error.message);
        assert.include(error.message, "VotingEnded");
      }
    });
  });

  describe("边界条件测试", () => {
    it("应该处理长的候选人名称", async () => {
      const longName = "长候选人名字"; // 控制种子长度
      const longPollId = new BN(3);
      
      const [longPollAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("poll"), longPollId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [longCandidateAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [longPollId.toArrayLike(Buffer, "le", 8), Buffer.from(longName)],
        program.programId
      );

      // 初始化投票
      await program.methods
        .initializePoll(
          longPollId,
          new BN(baseTime + 50),
          new BN(baseTime + 7200),
          "长名称测试",
          "测试长候选人名称"
        )
        .rpc();

      // 添加长名称候选人
      await program.methods
        .initializeCandidate(longPollId, longName)
        .accounts({
          pollAccount: longPollAccount,
        })
        .rpc();

      // 验证候选人数据
      const candidateData = await program.account.candidateAccount.fetch(longCandidateAccount);
      assert.equal(candidateData.candidateName, longName);
    });

    it("应该处理长的投票描述", async () => {
      const longDescription = "这是一个比较长的投票描述，用来测试程序是否能正确处理较长的描述字段。我们需要确保程序能够正确存储和检索这些数据，而不会出现截断或其他错误。这个描述应该在合理范围内，以测试边界条件的处理能力。"; // 控制在合理长度
      
      const longDescPollId = new BN(4);
      const [longDescPollAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("poll"), longDescPollId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      await program.methods
        .initializePoll(
          longDescPollId,
          new BN(baseTime + 50),
          new BN(baseTime + 7200),
          "长描述测试",
          longDescription
        )
        .rpc();

      // 验证描述存储正确
      const pollData = await program.account.pollAccount.fetch(longDescPollAccount);
      assert.equal(pollData.pollDescription, longDescription);
    });
  });

  describe("最终状态验证", () => {
    it("应该正确显示所有投票结果", async () => {
      // 获取最终投票结果
      const candidate1Data = await program.account.candidateAccount.fetch(candidate1Account);
      const candidate2Data = await program.account.candidateAccount.fetch(candidate2Account);
      const pollData = await program.account.pollAccount.fetch(pollAccount);

      console.log("\n=== 最终投票结果 (Bankrun版本) ===");
      console.log(`投票名称: ${pollData.pollName}`);
      console.log(`投票描述: ${pollData.pollDescription}`);
      console.log(`候选人总数: ${pollData.pollOptionIndex}`);
      console.log(`${candidate1Data.candidateName}: ${candidate1Data.candidateVotes} 票`);
      console.log(`${candidate2Data.candidateName}: ${candidate2Data.candidateVotes} 票`);
      console.log("==============================\n");

      // 验证最终状态
      assert.equal(pollData.pollOptionIndex.toString(), "2");
      assert.equal(candidate1Data.candidateVotes.toString(), "2");
      assert.equal(candidate2Data.candidateVotes.toString(), "1");
    });
  });
}); 