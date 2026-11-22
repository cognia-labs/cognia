import { classifySensitiveMemoryTopic } from "./sensitive-topics"

describe("classifySensitiveMemoryTopic", () => {
  it("detects health and medical statements in English and Chinese", () => {
    expect(
      classifySensitiveMemoryTopic("The user was diagnosed with type 2 diabetes last year.")
    ).toEqual({
      sensitive: true,
      categories: ["health"],
    })
    expect(classifySensitiveMemoryTopic("用户去年确诊患有抑郁症，目前正在接受心理治疗。")).toEqual({
      sensitive: true,
      categories: ["health"],
    })
  })

  it("detects religious and political beliefs", () => {
    expect(
      classifySensitiveMemoryTopic("User is a practicing Buddhist and attends temple weekly.")
    ).toEqual({
      sensitive: true,
      categories: ["beliefs"],
    })
    expect(classifySensitiveMemoryTopic("用户的宗教信仰是基督徒，政治立场偏保守。")).toEqual({
      sensitive: true,
      categories: ["beliefs"],
    })
  })

  it("detects personal finance and debt facts", () => {
    expect(
      classifySensitiveMemoryTopic("My annual salary is $145k and I still have student loans.")
    ).toEqual({
      sensitive: true,
      categories: ["finance"],
    })
    expect(classifySensitiveMemoryTopic("我的月薪是两万五，目前有个人房贷。")).toEqual({
      sensitive: true,
      categories: ["finance"],
    })
  })

  it("detects protected identity attributes", () => {
    expect(
      classifySensitiveMemoryTopic("User identifies as non-binary and is a wheelchair user.")
    ).toEqual({
      sensitive: true,
      categories: ["identity"],
    })
    expect(classifySensitiveMemoryTopic("用户的性别认同为非二元性别。")).toEqual({
      sensitive: true,
      categories: ["identity"],
    })
  })

  it("does not misclassify technical engineering vocabulary", () => {
    expect(
      classifySensitiveMemoryTopic(
        "The API health check endpoint tracks technical debt, token budget, and caller identity."
      )
    ).toEqual({
      sensitive: false,
      categories: [],
    })
    expect(classifySensitiveMemoryTopic("User prefers pnpm, TypeScript, and dark mode.")).toEqual({
      sensitive: false,
      categories: [],
    })
  })

  it("still detects sensitive personal facts mixed with technical terms", () => {
    expect(
      classifySensitiveMemoryTopic(
        "While paying down technical debt at work, the user is also paying off credit card debt."
      )
    ).toEqual({
      sensitive: true,
      categories: ["finance"],
    })
  })
})
