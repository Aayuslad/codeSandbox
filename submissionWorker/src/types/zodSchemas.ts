import zod from "zod";

export const taskSchema = zod.object({
	id: zod.string(),
	languageId: zod.number(),
	code: zod.string(),
	input: zod.string().optional(),
	expectedOutput: zod.string().optional(),
	callbackUrl: zod.string().optional(),
});

export const batchTaskSchema = zod.object({
	id: zod.number(),
	stdin: zod.string(),
	inputs: zod.string().optional(),
	expectedOutput: zod.string().optional(),
});

export const BatchSubmissionSchema = zod.object({
	id: zod.string(),
	languageId: zod.number(),
	submissionId: zod.string(),
	code: zod.string().base64(),
	callbackUrl: zod.string().optional(),
	tasks: zod.array(batchTaskSchema),
});
export type BatchSubmissionSchema = zod.infer<typeof BatchSubmissionSchema>;

export type BatchResult = {
	status: string;
	tasks: Array<{
		id: number;
		status: string;
		output: string;
		accepted: boolean;
		inputs: string;
		expectedOutput: string | undefined;
	}>;
};
