import { redisClient } from "../database/redisClient";
import { exec } from "child_process";
import { promisify } from "util";
import { BatchResult, BatchSubmissionSchema } from "../types/zodSchemas";
import axios from "axios";
import {
	BatchTaskQueueProcessorFunction,
	CompileInContainerFunction,
	ExecuteCompiledCode,
	InitializeContainersFunction,
} from "../types/controllerFunctionTypes";

const execPromise = promisify(exec);

const containerPool: Record<number, string> = {
	1: "", // Python
	2: "", // C++
	3: "", // Java
	4: "", // C
};

const initializeContainers: InitializeContainersFunction = async () => {
	try {
		const containerConfigs = [
			{ id: 1, image: "python:3.9" },
			{ id: 2, image: "gcc:latest" },
			{ id: 3, image: "openjdk:latest" },
			{ id: 4, image: "gcc:latest" },
		];

		await Promise.all(
			containerConfigs.map(async (config) => {
				const { stdout } = await execPromise(`docker run -d ${config.image} tail -f /dev/null`);
				containerPool[config.id] = stdout.trim();
			}),
		);

		console.log("Containers initialized:", containerPool);
	} catch (error) {
		console.error("Error initializing containers:", error);
		throw error;
	}
};

const compileInContainer: CompileInContainerFunction = async (languageId, code) => {
	const containerId = containerPool[languageId];
	if (!containerId) throw new Error(`No container found for language ID ${languageId}`);

	const compileCommands: Record<number, string> = {
		1: `docker exec -i ${containerId} sh -c 'echo "${code}" | base64 -d > Solution.py && python -m py_compile Solution.py'`,
		2: `docker exec -i ${containerId} sh -c 'echo "${code}" | base64 -d > Solution.cpp && g++ Solution.cpp -o myapp'`,
		3: `docker exec -i ${containerId} sh -c 'echo "${code}" | base64 -d > Solution.java && javac Solution.java'`,
		4: `docker exec -i ${containerId} sh -c 'echo "${code}" | base64 -d > Solution.c && gcc Solution.c -o myapp'`,
	};

	const compileCommand = compileCommands[languageId];
	if (!compileCommand) throw new Error(`No compile command defined for language ID ${languageId}`);

	try {
		const start = Date.now();
		await execPromise(compileCommand);
		const end = Date.now();
		console.log(`Compilation time: ${end - start}ms`);
		return { containerId, compileStatus: "compiled successfully" };
	} catch (error) {
		console.error("Error compiling code:", error);
		return { containerId: "", compileStatus: "compilation error" };
	}
};

const executeCompiledCode: ExecuteCompiledCode = async (id, languageId, containerId, inputs, tasks) => {
	const executeCommands: Record<number, (input: string) => string> = {
		1: (input: string) => `echo "${input}" | base64 -d | docker exec -i ${containerId} python Solution.py`,
		2: (input: string) => `echo "${input}" | base64 -d | docker exec -i ${containerId} ./myapp`,
		3: (input: string) => `echo "${input}" | base64 -d | docker exec -i ${containerId} java Solution`,
		4: (input: string) => `echo "${input}" | base64 -d | docker exec -i ${containerId} ./myapp`,
	};

	const executeCommand = executeCommands[languageId];
	if (!executeCommand) {
		throw new Error(`No execute command defined for language ID ${languageId}`);
	}

	let allTasksAccepted = true;

	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		const existingResult = await redisClient.get(`batchResult:${id}`);
		let batchResult: BatchResult = existingResult ? JSON.parse(existingResult) : { status: "executing", tasks: [] };

		try {
			const command = executeCommand(input);
			const start = Date.now();
			const { stdout, stderr } = await execPromise(command);
			const end = Date.now();
			console.log("Execution time:", end - start + "ms");

			const taskResult = {
				id: tasks[index].id,
				status: stderr ? "error" : "success",
				output: stderr || stdout.trim(),
				accepted: !stderr && stdout.trim() === tasks[index].expectedOutput,
				inputs: tasks[index].inputs || "",
				expectedOutput: tasks[index].expectedOutput,
			};

			batchResult.tasks.push(taskResult);
			await redisClient.set(`batchResult:${id}`, JSON.stringify(batchResult));

			if (!taskResult.accepted) {
				allTasksAccepted = false;
				break;
			}
		} catch (error) {
			console.error("Runtime error:", error);
			batchResult.status = "run time error";
			batchResult.tasks = [];
			await redisClient.set(`batchResult:${id}`, JSON.stringify(batchResult));
			return { allTasksAccepted: false, executionStatus: "run time error" };
		}
	}

	return { allTasksAccepted, executionStatus: "completed" };
};

export const batchTaskQueueProcessor: BatchTaskQueueProcessorFunction = async () => {
	await initializeContainers();

	while (redisClient.isOpen) {
		const batchTask = await redisClient.blPop("batch-task-execution-queue", 0);
		if (!batchTask) continue;

		const parsedBatchTask = BatchSubmissionSchema.safeParse(JSON.parse(batchTask.element));
		if (!parsedBatchTask.success) continue;

		const { id, submissionId, languageId, callbackUrl, code, tasks } = parsedBatchTask.data;
		console.log("Batch task received:", id);

		try {
			await updateBatchResult(id, "executing");

			const { containerId, compileStatus } = await compileInContainer(languageId, code);
			if (compileStatus === "compilation error") {
				await updateBatchResult(id, "compilation error");
				continue;
			}

			const { allTasksAccepted, executionStatus } = await executeCompiledCode(
				id,
				languageId,
				containerId,
				tasks.map((task) => task.stdin),
				tasks,
			);

			if (executionStatus === "run time error") {
				await updateBatchResult(id, "run time error");
				continue;
			}

			const batchResult = await redisClient.get(`batchResult:${id}`);
			const parsedBatchResult: BatchResult = JSON.parse(batchResult as string);

			parsedBatchResult.status = allTasksAccepted ? "accepted" : "rejected";
			await redisClient.set(`batchResult:${id}`, JSON.stringify(parsedBatchResult));

			if (callbackUrl) {
				await sendCallback(callbackUrl, submissionId, allTasksAccepted);
			}
		} catch (error) {
			console.error("Error processing batch task:", error);

			if (callbackUrl) {
				await sendCallback(callbackUrl, submissionId, false);
			}
		}
	}
};


// ######## utils ########

const sendCallback = async (callbackUrl: string, submissionId: string, accepted: boolean) => {
	try {
		await axios.post(callbackUrl, { submissionId, accepted });
	} catch (error) {
		console.error("Error sending callback:", error);
	}
};

const updateBatchResult = async (id: string, status: string, tasks: any[] = []) => {
	await redisClient.set(`batchResult:${id}`, JSON.stringify({ status, tasks }));
};
